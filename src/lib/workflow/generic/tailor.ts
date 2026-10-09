// tailor.lines (After Phase 9, user decision 2026-10-09): the resume Tailor
// step (docs/workflows-by-document-type.md, Resume / CV, steps 4 and 5). The
// model proposes line changes from the master history: rewrite a line, lead
// with it (move it to the top of its list) or trim it. Nothing reaches the
// author unchecked:
// - code checks (checkTailorLines): the line must be one Sasha showed, every
//   rewrite must cite a master passage it was shown, and every number in the
//   new text (with its scale: $2K is not $2M, 3+ is not 3, "fifteen" is 15)
//   must already be in the line or in those passages; a line may only serve a
//   requirement the master meets (never a GAP); only a list item may lead (a
//   paragraph moved to the top of its section could land under another
//   employer's header), and a paragraph that heads a list or holds a date or
//   number (a job's header line) is never trimmed, which would leave its
//   bullets under the job above;
// - a truth trace (the model, against the master history only) on every line
//   with new text.
// Lines that fail are dropped and reported as minor findings (they are never
// proposed, so they must not block the outcome). `original`, `sectionId` and
// `heading` always come from the document as read (src/lib/workflow/lines.ts),
// so the editor can find each line again when the author applies it. With no
// master passages, no line it may change, or no requirement the master meets,
// it makes no model call.

import { claudeJson } from "@/lib/llm/claude";
import { stripCitationMarkers } from "@/lib/sections/content";
import type { EvidenceLink, ExtractedItem, OutcomeTable, ReplaceLine, TracedItem } from "../contract";
import type { NodeHandler } from "../context";
import { documentLines, normalizeLine, type DocLine } from "../lines";
import type { TailorConfig } from "../node-specs/generic";
import { TRACE_SYSTEM } from "../nodes/prompts";
import { applyTrace, traceSchema, traceUserPrompt, type TraceConfig, type TraceMaterial, type TraceReply } from "../nodes/trace";
import type { SourcesSnapshot } from "../nodes/types";
import { LINE_ACTION_LABELS } from "../nodes/write";
import { asDoc, asItems, asSources, callOpts, clip, EvidenceIndex, Findings, gateBoundSources, itemName, narrowedAway, narrowSources, outcomeTable, statusFor } from "../nodes/util";
import { TAILOR_SYSTEM, TailorReply, tailorUserPrompt } from "./tailor-prompts";

/** The truth check on proposed lines (spec step 5): minor, since a failing line is dropped, never proposed. */
export const TAILOR_TRUTH: TraceConfig = {
  against: "sources",
  statuses: [
    { key: "in_master", label: "Matches the master", ok: true, severity: "info" },
    { key: "overstated", label: "Says more than the master", ok: false, severity: "minor" },
    { key: "not_in_master", label: "Not in the master", ok: false, severity: "minor" },
  ],
  unverifiedStatus: "not_in_master",
  question:
    "Does the master history state every fact in this rewritten line (employer, title, dates, degree, certification, skill, number, achievement), with titles and dates unchanged and numbers the same? The candidate's role, scope and seniority are facts too: led, managed or owned versus contributed to, assisted or supported; team size; sole versus shared credit. A stronger verb or a bigger scope than the master states is overstated. Otherwise judge facts, not wording; the posting is not evidence.",
  bothWays: false,
  instructions: "",
  excludeSources: [],
};

/** A requirement as the before trace left it (status direct, adjacent or none). */
type Requirement = ExtractedItem & { status?: string };

export type TailorMaterial = {
  /** The lines the model was shown (eligible sections only). */
  lines: DocLine[];
  /** The master history: the only passages a line may rest on. */
  master: SourcesSnapshot | null;
  requirements: Requirement[];
  maxLines: number;
};

/** A line the checks dropped, with what is known of it and why. */
export type DroppedLine = { line: Partial<ReplaceLine>; why: string; status?: string };

/** Passage ids or citation markers the model put in the text anyway (as draft.section strips them). */
const cleanText = (s: string) =>
  stripCitationMarkers(s.replace(/\s?\[S[0-9a-f]{8}\.P\d+\]/gi, ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

/** The cited refs with a quote: an empty quote is checked against nothing, so it is never support (the spec asks for a short exact quote). */
const quoted = <T extends { quote: string }>(refs: T[]) => refs.filter((r) => r.quote.trim());

/** Pure: the trace reply with only quoted evidence, so applyTrace downgrades a pass that cites none. */
export function quotedTrace(reply: TraceReply): TraceReply {
  return { ...reply, items: reply.items.map((r) => ({ ...r, evidence: quoted(r.evidence) })) };
}

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
const UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_RE = /(?<![\p{L}\d])(\d[\d,.]*)(?:([kKmMbBtTxX])(?![\p{L}\p{N}])|\s?(thousand|million|billion|trillion|percent)\b|(%|\+))?/gu;
// Spelled-out numbers ("fifteen", "twenty-five", "a dozen"); "one" is left out, as it is more often a word than a count.
const WORD_RE = new RegExp(`\\b(?:(${Object.keys(TENS).join("|")})(?:[-\\s](${UNITS.slice(1, 10).join("|")}))?|(${UNITS.slice(2).join("|")})|(dozen))\\b`, "gi");
// A magnitude with no digit before it: "a thousand" is 1000 (as "a dozen" is 12); "hundreds of clients", "dozens of teams" or
// "several thousand" is a scale with no figure, which the line or its passages must already state.
const MAGNITUDE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const MAGNITUDE_RE = /(?<!\d\s?)\b(?:(an?|one)\s+)?(?:dozens|(hundred|thousand|million|billion|trillion)(s?))\b/gi;
// Period markers ("Q4", "H1", "FY2022", "FY 22"): one token each, so a rewrite that moves Q4 to Q2 is a changed number.
const PERIOD_RE = /\b(Q[1-4]|H[12]|FY\s?\d{2,4})\b/gi;

/**
 * Pure: the numbers in a text as comparable tokens: the value with its scale
 * applied ("$1.2M" and "1,200,000" are both "1200000"; "$2K" is "2000", never
 * "2" as "$2M" would be), a trailing %, + or x kept ("3+" is not "3"), and
 * spelled-out numbers as digits ("fifteen" and "a thousand" are "15" and
 * "1000"), a magnitude with no figure as its word ("hundreds of clients" is
 * "~hundred"), and a period
 * marker whole ("Q4", "H1", "FY2022"; never the digits inside it), so a code
 * check can see a rewrite that changes a number's scale or spells one in.
 */
export function numberTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PERIOD_RE)) out.push(m[1].replace(/\s/g, "").toUpperCase());
  for (const m of text.matchAll(MAGNITUDE_RE)) {
    const [, article, word, plural] = m.map((x) => x?.toLowerCase());
    out.push(article && word && !plural ? String(MAGNITUDE[word]) : `~${word ?? "dozen"}`);
  }
  for (const m of text.matchAll(NUMBER_RE)) {
    const digits = m[1].replace(/,/g, "").replace(/\.+$/, "");
    const scale = (m[2] ?? m[3] ?? "").toLowerCase();
    const mark = m[4] ?? (scale === "x" ? "x" : scale === "percent" ? "%" : "");
    const factor = SCALE[scale];
    out.push(`${factor ? String(Math.round(Number(digits) * factor * 1000) / 1000) : digits}${mark}`);
  }
  for (const m of text.matchAll(WORD_RE)) {
    const [, tens, unit, single, dozen] = m.map((x) => x?.toLowerCase());
    out.push(String(dozen ? 12 : tens ? TENS[tens] + (unit ? UNITS.indexOf(unit) : 0) : UNITS.indexOf(single!)));
  }
  return out;
}

/** Pure: is the line's section one tailor.lines may change? (Never the preamble: name and contact details.) */
export function eligibleLine(line: DocLine, sectionKeys: string[], renderers: Map<string, string>): boolean {
  if (line.sectionId === null) return false;
  if (sectionKeys.length) return !!line.specKey && sectionKeys.includes(line.specKey);
  return !line.specKey || renderers.get(line.specKey) !== "static";
}

/** The before statuses a line may claim to serve: the master meets them. A GAP (none, or no status) is never served. */
const MET = new Set(["direct", "adjacent"]);

export const LEAD_NOT_IN_LIST = "Only a list item can move to the top: moving a paragraph could put it under another employer's header.";
export const TRIM_HEADER = "It looks like a header line (it holds a date or number, or a list follows it): trimming it would leave the lines below it under the entry above.";
export const ONLY_GAPS = "It claims to serve only requirements the master history doesn't meet (gaps), and gaps stay gaps.";

/** Pure: which repeat of its text the line is within its section (0 for the first), and how many there are, in document order. */
export function lineOccurrence(lines: DocLine[], line: DocLine): { occurrence: number; occurrences: number } {
  const same = lines.filter((l) => l.sectionId === line.sectionId && normalizeLine(l.text) === normalizeLine(line.text));
  return { occurrence: Math.max(0, same.indexOf(line)), occurrences: same.length };
}

/**
 * Pure: the model's lines checked in code, in order: a ref Sasha showed (the
 * first entry for it), cleaned text, a rewrite that changes something, a lead
 * only on a list item, no trim of a header-like paragraph, verified
 * master-passage support for new text, and no number the line and its passages
 * don't already hold. Requirement keys are kept only when the master meets
 * them; a rewrite or lead that names only gaps is dropped. Each line records
 * which repeat of its text it is in its section, so the editor changes that
 * one. The list is capped at maxLines and numbered L1….
 */
export function checkTailorLines(reply: TailorReply, m: TailorMaterial): { lines: ReplaceLine[]; dropped: DroppedLine[] } {
  const byRef = new Map(m.lines.map((l) => [l.ref, l]));
  const index = new EvidenceIndex({ sources: m.master });
  const known = new Set(m.requirements.map((r) => r.id));
  const met = new Set(m.requirements.filter((r) => MET.has(r.status ?? "none")).map((r) => r.id));
  const seen = new Set<string>();
  const lines: ReplaceLine[] = [];
  const dropped: DroppedLine[] = [];
  for (const r of reply.lines) {
    const ref = r.line.trim().replace(/^\[|\]$/g, "").toUpperCase();
    const doc = byRef.get(ref);
    const text = cleanText(r.text);
    if (!doc) {
      dropped.push({ line: { action: r.action, proposed: text, reason: r.reason }, why: "Not a line Sasha showed." });
      continue;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    const base = { action: r.action, sectionId: doc.sectionId, heading: doc.heading, original: doc.text, ...lineOccurrence(m.lines, doc), reason: clip(r.reason.trim(), 500) };
    const named = [...new Set(r.requirements.map((k) => k.trim()).filter((k) => known.has(k)))];
    const requirementKeys = named.filter((k) => met.has(k));
    if (r.action === "trim") {
      const i = m.lines.indexOf(doc);
      const next = m.lines[i + 1];
      if (!doc.inList && (numberTokens(doc.text).length || (next && next.sectionId === doc.sectionId && next.inList))) {
        dropped.push({ line: { ...base, proposed: "", requirementKeys, evidence: [] }, why: TRIM_HEADER });
        continue;
      }
      lines.push({ id: "", ...base, proposed: "", requirementKeys, evidence: [] });
      continue;
    }
    if (named.length && !requirementKeys.length) {
      dropped.push({ line: { ...base, proposed: text, requirementKeys: named, evidence: [] }, why: ONLY_GAPS });
      continue;
    }
    if (r.action === "lead" && !doc.inList) {
      dropped.push({ line: { ...base, proposed: text || doc.text, requirementKeys, evidence: [] }, why: LEAD_NOT_IN_LIST });
      continue;
    }
    const unchanged = !text || normalizeLine(text) === normalizeLine(doc.text);
    if (r.action === "rewrite" && unchanged) continue;
    if (r.action === "lead" && unchanged) {
      lines.push({ id: "", ...base, proposed: doc.text, requirementKeys, evidence: [] });
      continue;
    }
    const cited = index.links(r.support, "for").filter((e) => e.kind === "passage");
    const evidence = index.links(quoted(r.support), "for").filter((e) => e.kind === "passage" && e.verified);
    const candidate = { ...base, proposed: text, requirementKeys };
    if (!evidence.length) {
      dropped.push({ line: { ...candidate, evidence: cited }, why: "No master passage supports it." });
      continue;
    }
    const allowed = new Set([doc.text, ...evidence.map((e) => index.passages.get(e.ref)?.text ?? "")].flatMap(numberTokens));
    const added = numberTokens(text).filter((n) => !allowed.has(n));
    if (added.length) {
      dropped.push({ line: { ...candidate, evidence }, why: `It has a number that is not in the master (${[...new Set(added)].join(", ")}).` });
      continue;
    }
    lines.push({ id: "", ...candidate, evidence });
  }
  return { lines: lines.slice(0, m.maxLines).map((l, i) => ({ ...l, id: `L${i + 1}` })), dropped };
}

/** Pure: the lines whose new text the truth check reads (rewrites, and leads that change the text), as trace items. */
export function truthItems(lines: ReplaceLine[], specKeyFor: (sectionId: string | null) => string | null): ExtractedItem[] {
  return lines
    .filter((l) => l.action === "rewrite" || (l.action === "lead" && l.proposed !== l.original))
    .map((l) => ({ id: l.id, fields: { line: l.proposed, original: l.original }, location: { sectionId: l.sectionId, specKey: specKeyFor(l.sectionId), heading: l.heading, quote: clip(l.original, 500) }, evidence: l.evidence }));
}

const dedupe = (links: EvidenceLink[]) => [...new Map(links.map((e) => [`${e.kind}:${e.ref}`, e])).values()];

/** Pure: the trace applied to the lines: failing lines dropped, passing ones keep the trace's verified evidence; renumbered L1…. */
export function applyTruth(lines: ReplaceLine[], traced: TracedItem[]): { lines: ReplaceLine[]; dropped: DroppedLine[] } {
  const byId = new Map(traced.map((t) => [t.id, t]));
  const kept: ReplaceLine[] = [];
  const dropped: DroppedLine[] = [];
  for (const l of lines) {
    const t = byId.get(l.id);
    if (!t) {
      kept.push(l);
      continue;
    }
    const s = statusFor(TAILOR_TRUTH.statuses, t.status);
    if (s.ok) kept.push({ ...l, evidence: dedupe(t.evidence.filter((e) => e.verified)) });
    else dropped.push({ line: l, why: `${s.label}: ${t.rationale}`.trim(), status: s.key });
  }
  return { lines: kept.map((l, i) => ({ ...l, id: `L${i + 1}` })), dropped };
}

function linesTable(nodeId: string, lines: ReplaceLine[], requirements: Requirement[]): OutcomeTable {
  const names = new Map(requirements.map((r) => [r.id, itemName(r)]));
  return outcomeTable(
    nodeId,
    "Proposed lines",
    [
      { key: "section", label: "Section" },
      { key: "action", label: "Change" },
      { key: "original", label: "Was" },
      { key: "proposed", label: "Proposed" },
      { key: "requirements", label: "Requirements" },
      { key: "why", label: "Why" },
    ],
    lines.map((l) => ({
      cells: { section: l.heading, action: LINE_ACTION_LABELS[l.action], original: l.original, proposed: l.proposed, requirements: l.requirementKeys.map((k) => names.get(k) ?? k).join("; "), why: l.reason },
      status: l.action,
      evidence: l.evidence,
    })),
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const tailorLinesHandler: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as TailorConfig;
  const id = node.node.id;
  const doc = await ctx.document();
  const renderers = new Map((asDoc(inputs.document)?.type?.sections ?? []).map((s) => [s.key, s.renderer ?? "narrative"]));
  const all = documentLines(doc.content_json);
  const lines = all.filter((l) => eligibleLine(l, config.sectionKeys, renderers));
  const linked = asSources(inputs.sources);
  const narrow = { match: config.masterMatch, exclude: config.excludeSources, excludeIds: gateBoundSources(inputs.gate, config.excludeBound ?? []) };
  const master = narrowSources(linked, narrow);
  const requirements = asItems(inputs.requirements) as Requirement[];
  const findings = new Findings(id);
  const specKeyFor = (sectionId: string | null) => all.find((l) => l.sectionId === sectionId)?.specKey ?? null;

  const nothing = !master?.passages.length
    ? "no master history passages are linked"
    : !lines.length
      ? "the resume has no lines in the sections it may change"
      : !requirements.some((r) => r.status === "direct" || r.status === "adjacent")
        ? "no requirement has evidence in the master history"
        : null;
  if (nothing) {
    findings.add({ kind: "tailor_summary", severity: "info", status: "nothing", title: `Nothing to tailor: ${nothing}`, detail: narrowedAway(linked, narrow) });
    return { op: null, lines: [], findings: findings.list(), table: linesTable(id, [], requirements) };
  }

  const m: TailorMaterial = { lines, master, requirements, maxLines: config.maxLines };
  const { data } = await claudeJson({
    task: "workflow.tailor",
    system: TAILOR_SYSTEM,
    user: tailorUserPrompt({ requirements, lines, master: master!, instructions: config.instructions, maxLines: config.maxLines }),
    schema: TailorReply,
    ...callOpts(ctx),
  });
  const checked = checkTailorLines(data, m);

  // The truth check: only the master history is shown; a failed call fails the step (never propose unchecked lines).
  const items = truthItems(checked.lines, specKeyFor);
  let truth: { lines: ReplaceLine[]; dropped: DroppedLine[] } = { lines: checked.lines, dropped: [] };
  if (items.length) {
    const tm: TraceMaterial = { items, targets: [], sources: master, doc: null, tables: [] };
    const reply = await claudeJson({ task: "workflow.trace", system: TRACE_SYSTEM, user: traceUserPrompt(TAILOR_TRUTH, tm), schema: traceSchema(TAILOR_TRUTH.statuses), ...callOpts(ctx) });
    truth = applyTruth(checked.lines, applyTrace(quotedTrace(reply.data as TraceReply), TAILOR_TRUTH, tm, new EvidenceIndex({ sources: master })));
  }

  const proposed = truth.lines;
  const dropped = [...checked.dropped, ...truth.dropped];
  const byTruth = truth.dropped.length;
  const byCode = checked.dropped.length;
  const droppedText = !dropped.length ? "" : byTruth && byCode ? `; ${byTruth} dropped by the truth check, ${byCode} by the code checks` : byTruth ? `; ${byTruth} dropped by the truth check` : `; ${byCode} dropped by the code checks`;
  findings.add({
    kind: "tailor_summary",
    severity: "info",
    status: proposed.length ? "proposed" : "nothing",
    title: `${proposed.length ? `Proposed ${plural(proposed.length, "line change")}` : "No line changes proposed"}${droppedText}`,
    detail: proposed.length ? "Accept or reject each line in the Workflows pane; the run goes on once you apply or discard them." : "",
    evidence: dedupe(proposed.flatMap((l) => l.evidence)).slice(0, 12),
  });
  for (const d of dropped) {
    findings.add({
      kind: "tailor_line_dropped",
      severity: "minor",
      status: d.status ?? "dropped",
      title: `Dropped: “${clip(d.line.proposed || d.line.original || "", 120)}”`,
      detail: d.why,
      location: d.line.original !== undefined ? { sectionId: d.line.sectionId ?? null, specKey: specKeyFor(d.line.sectionId ?? null), heading: d.line.heading ?? null, quote: clip(d.line.original, 500) } : null,
      evidence: d.line.evidence ?? [],
    });
  }
  return {
    op: proposed.length ? { op: "replace_lines", lines: proposed } : null,
    lines: proposed,
    findings: findings.list(),
    table: linesTable(id, proposed, requirements),
  };
};
