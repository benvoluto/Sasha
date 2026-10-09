// Helpers every step node shares: reading loosely typed inputs, the deadline a
// model call must fit in, checking the ids and quotes a model cites against
// what it was given, and building findings and tables. Server-only (the
// handlers are), but pure apart from callOpts' clock.

import { CLAUDE_REQUEST_TIMEOUT_MS, CLAUDE_STREAM_DEADLINE_MS } from "@/lib/llm/claude";
import { normalizeForMatching } from "@/lib/text-match";
import { MAX_EVIDENCE, MAX_FINDINGS, MAX_QUOTE_CHARS, SEVERITIES, type DocLocation, type EvidenceLink, type ExtractedItem, type Finding, type OutcomeTable, type Severity } from "../contract";
import { NodeError, type NodeContext } from "../context";
import type { StatusSpec } from "../node-specs/steps";
import type { DocSnapshot, NotesView, PassageView, RequirementsView, SectionView, SourcesSnapshot, SourceView, TableView } from "./types";

// --- Time -------------------------------------------------------------------------

/** A model call needs at least this long; with less left the step fails instead of being cut off. */
export const MIN_CALL_MS = 10_000;

/** agent, documentId and the time limits for a model call made by a node. */
export function callOpts(ctx: NodeContext, now = Date.now()) {
  const left = ctx.deadline - now;
  if (left < MIN_CALL_MS) throw new NodeError("not enough time left in this run for a model call; continue the run");
  return { agent: ctx.agent, documentId: ctx.documentId, deadlineMs: Math.min(CLAUDE_STREAM_DEADLINE_MS, left), timeoutMs: Math.min(CLAUDE_REQUEST_TIMEOUT_MS, left) };
}

// --- Inputs ------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A json input as a flat list: a value, a list, or (multiple inputs, loop outputs) a list of lists. Nulls dropped. */
export function flat<T = unknown>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [v as T];
  return v.flatMap((x) => flat<T>(x));
}

export function asDoc(v: unknown): DocSnapshot | null {
  const d = flat(v)[0];
  return isObj(d) && Array.isArray(d.sections) && typeof d.text === "string" ? (d as DocSnapshot) : null;
}

/** sources.read's {sources, passages}, or sources.list's SourceView[] (no passages). */
export function asSources(v: unknown): SourcesSnapshot | null {
  if (v === undefined || v === null) return null;
  if (isObj(v) && Array.isArray(v.sources)) return { sources: v.sources as SourceView[], passages: Array.isArray(v.passages) ? (v.passages as PassageView[]) : [] };
  const list = flat(v);
  const snap = list.find((x) => isObj(x) && Array.isArray(x.sources));
  if (snap) return asSources(snap);
  const sources = list.filter((x): x is SourceView => isObj(x) && typeof x.id === "string" && typeof x.title === "string");
  return sources.length ? { sources, passages: [] } : null;
}

/**
 * Linked data tables, and an earlier step's outcome table (the agreed options
 * matrix) read the same way, so a later step can be given what it found.
 */
export function asTables(v: unknown): TableView[] {
  return flat(v).flatMap((x): TableView[] => {
    if (!isObj(x) || !Array.isArray(x.columns) || !Array.isArray(x.rows)) return [];
    if (typeof x.id === "string") return [x as TableView];
    return typeof x.key === "string" && typeof x.title === "string" ? [fromOutcomeTable(x as unknown as OutcomeTable)] : [];
  });
}

/** Pure: an outcome table as a table view (id "step:<key>"; no source). */
export function fromOutcomeTable(t: OutcomeTable): TableView {
  const rows = t.rows.map((r) => t.columns.map((c) => r.cells?.[c.key] ?? null));
  return { id: `step:${t.key}`, name: t.title, sourceId: "", sourceTitle: "An earlier step of this run", columns: t.columns.map((c) => ({ key: c.key, label: c.label, type: "text", unit: null })), rowCount: rows.length, rows };
}

/** Which sources narrowSources keeps: by keyword, less any whose id is in `excludeIds` (the source a gate bound as the posting). */
export type NarrowOpts = { match: string[]; exclude: string[]; excludeIds?: ReadonlySet<string> };

/**
 * Pure: the sources whose `title role` names a `match` keyword (every source when `match` is
 * empty), less any that name an `exclude` keyword or whose id is in `excludeIds`, with only their
 * passages. Keywords match at word starts (containsKeyword, as the gate binds inputs), so an
 * exclude phrase such as "job posting" never drops a master titled "Work history (all jobs)".
 * Exclusion wins over a match: a posting titled "Resume writer: job description" must never
 * become master evidence. The resume steps use it to keep the master history and leave the job
 * posting out. Null stays null.
 */
export function narrowSources(s: SourcesSnapshot | null, opts: NarrowOpts): SourcesSnapshot | null {
  if (!s) return null;
  const label = (x: SourceView) => `${x.title} ${x.role ?? ""}`;
  const sources = s.sources.filter(
    (x) => !opts.excludeIds?.has(x.id) && (!opts.match.length || opts.match.some((k) => containsKeyword(label(x), k))) && !opts.exclude.some((k) => containsKeyword(label(x), k)),
  );
  const kept = new Set(sources.map((x) => x.id));
  return { sources, passages: s.passages.filter((p) => kept.has(p.sourceId)) };
}

/** Pure: why narrowSources left nothing although sources are linked ("" when it kept some, or none were linked). */
export function narrowedAway(s: SourcesSnapshot | null, opts: NarrowOpts): string {
  if (!s?.sources.length || narrowSources(s, opts)!.sources.length) return "";
  const titles = s.sources.map((x) => `“${clip(x.title, 80)}”`).join(", ");
  const want = opts.match.length ? `; this step reads only sources whose title or role names ${opts.match.join(", ")}` : "";
  const skip = opts.exclude.length ? `${want ? " and" : ";"} it leaves out those naming ${opts.exclude.join(", ")}` : "";
  const bound = opts.excludeIds?.size ? `${want || skip ? " and" : ";"} it leaves out the source the gate found as the job posting` : "";
  return `None of the linked sources (${titles}) is one this step checks against${want}${skip}${bound}.`;
}

/**
 * Pure: the ids of the sources a gate report (step.gate's `report`) bound under one of `keys`
 * (the resume's "job"), so a step can leave the posting out of master evidence whatever it is
 * titled ("Acme careers: Resume Specialist" names "resume"). A source the gate also bound under
 * another input is kept when that input has no source of its own: a master titled "Jane Doe CV -
 * careers 2015-2025" is bound as both, and is then the only master there is. Empty without keys
 * or a report.
 */
export function gateBoundSources(report: unknown, keys: string[]): Set<string> {
  const items = keys.length ? flat<{ items?: unknown }>(report).flatMap((r) => (isObj(r) && Array.isArray(r.items) ? r.items : [])) : [];
  const ids = (it: unknown) =>
    new Set(isObj(it) && Array.isArray(it.evidence) ? it.evidence.flatMap((e) => (isObj(e) && e.kind === "source" && typeof e.ref === "string" ? [e.ref] : [])) : []);
  const keyOf = (it: unknown) => (isObj(it) && typeof it.key === "string" ? it.key : "");
  const out = new Set(items.filter((it) => keys.includes(keyOf(it))).flatMap((it) => [...ids(it)]));
  for (const it of items) {
    if (keys.includes(keyOf(it))) continue;
    const own = ids(it);
    if (own.size && [...own].every((id) => out.has(id))) for (const id of own) out.delete(id);
  }
  return out;
}

export function asNotes(v: unknown): NotesView | null {
  const n = flat(v)[0];
  return isObj(n) && typeof n.scratchpad === "string" ? (n as NotesView) : null;
}

export function asRequirements(v: unknown): RequirementsView | null {
  const all = flat(v).filter((x): x is RequirementsView => isObj(x) && Array.isArray(x.items) && Array.isArray(x.sets));
  if (!all.length) return null;
  return { sets: all.flatMap((r) => r.sets), items: all.flatMap((r) => r.items) };
}

export function asItems(v: unknown): ExtractedItem[] {
  return flat(v).filter((x): x is ExtractedItem => isObj(x) && typeof x.id === "string" && isObj(x.fields));
}

// --- Text --------------------------------------------------------------------------

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Text as matched: typography folded, whitespace collapsed, lowercased. */
export const norm = (s: string) => normalizeForMatching(s).toLowerCase().trim();

/** Does `haystack` contain `needle` once both are normalized? (An empty needle is never "found".) */
export function contains(haystack: string, needle: string): boolean {
  const n = norm(needle).replace(/…$/, "").trim();
  return !!n && norm(haystack).includes(n);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `haystack` contain the keyword `needle` at the start of a word? Gate
 * cues are word starts ("evaluation" finds "evaluations", not
 * "reevaluation"); an acronym ("FIE", "CV", "NoA") must also end the word, so
 * "FIE" finds neither "identified" nor "Field" (a trailing "s" is allowed).
 */
export function containsKeyword(haystack: string, needle: string): boolean {
  const raw = needle.replace(/…$/, "").trim();
  const n = norm(raw);
  if (!n) return false;
  const acronym = /^[A-Za-z0-9]{2,8}$/.test(raw) && (raw.match(/[A-Z]/g)?.length ?? 0) >= 2;
  const end = acronym ? "s?(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}${end}`, "u").test(norm(haystack));
}

/** A field value as display text. */
export function fieldText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(String).join("; ");
  return String(v);
}

/** An item's display name: its first non-empty text field, else its id. */
/** Fields that name an item, tried before the rest (a leading `kind` enum such as "budget_line" names nothing). */
const NAME_FIELDS = ["name", "title", "text", "statement", "aim", "requirement"];

export function itemName(item: ExtractedItem): string {
  for (const key of NAME_FIELDS) {
    const t = fieldText(item.fields[key] ?? null).trim();
    if (t) return clip(t, 200);
  }
  for (const v of Object.values(item.fields)) {
    const t = fieldText(v).trim();
    if (t) return clip(t, 200);
  }
  return item.id;
}

// --- Evidence -----------------------------------------------------------------------

/** What a model cites: an id it was given and, optionally, the words it relies on. */
export type CitedRef = { id: string; quote?: string | null };

const cleanId = (id: string) => id.trim().replace(/^\[|\]$/g, "").trim();

/**
 * The ids a step showed the model, so cited ids can be checked: passages and
 * sources (S), document sections (D), data tables, extracted items (by the id
 * shown, which may be an alias such as "T3"), requirement items and notes.
 */
export class EvidenceIndex {
  readonly passages = new Map<string, PassageView>();
  readonly sources = new Map<string, SourceView>();
  readonly sections = new Map<string, SectionView>();
  readonly tables = new Map<string, TableView>();
  readonly items = new Map<string, ExtractedItem>();
  readonly requirements = new Map<string, { title: string; text: string; citation?: string }>();
  private readonly sourcePrefixes = new Map<string, SourceView>();
  private readonly doc: DocSnapshot | null;
  private readonly notes: NotesView | null;

  constructor(m: { doc?: DocSnapshot | null; sources?: SourcesSnapshot | null; tables?: TableView[]; items?: Array<[string, ExtractedItem]>; requirements?: RequirementsView | null; notes?: NotesView | null }) {
    this.doc = m.doc ?? null;
    this.notes = m.notes ?? null;
    for (const s of m.sources?.sources ?? []) {
      this.sources.set(s.id, s);
      this.sourcePrefixes.set(`S${s.id.replace(/-/g, "").slice(0, 8)}`, s);
    }
    for (const p of m.sources?.passages ?? []) this.passages.set(p.id, p);
    for (const s of m.doc?.sections ?? []) this.sections.set(s.sectionId, s);
    for (const t of m.tables ?? []) this.tables.set(t.id, t);
    for (const [shown, item] of m.items ?? []) this.items.set(shown, item);
    for (const r of m.requirements?.items ?? []) this.requirements.set(r.ref, r);
  }

  /** The link for one cited id, or null when the id was not given. A quote that isn't in the cited text keeps the link, unverified. */
  link(ref: CitedRef, stance: EvidenceLink["stance"] = "neutral"): EvidenceLink | null {
    const id = cleanId(ref.id ?? "");
    const quote = clip((ref.quote ?? "").trim(), MAX_QUOTE_CHARS);
    const base = { quote, stance, page: null as number | null, sourceId: null as string | null };
    const checked = (text: string) => (quote ? contains(text, quote) : true);
    const p = this.passages.get(id);
    if (p) {
      const src = this.sources.get(p.sourceId);
      return { ...base, kind: "passage", ref: p.id, sourceId: p.sourceId, label: clip(src?.title ?? "Source", 300), quote: quote || clip(p.text, 300), page: p.page, verified: checked(p.text) };
    }
    const sec = this.sections.get(id);
    if (sec) return { ...base, kind: "document", ref: sec.sectionId, label: clip(sec.heading, 300), verified: checked(`${sec.heading}\n${sec.text}`) };
    if (id === "doc" && this.doc) return { ...base, kind: "document", ref: "doc", label: clip(this.doc.title || "Document", 300), verified: checked(this.doc.text) };
    const item = this.items.get(id);
    if (item) return { ...base, kind: "item", ref: item.id, label: itemName(item), verified: true };
    const src = this.sources.get(id) ?? this.sourcePrefixes.get(id);
    if (src) return { ...base, kind: "source", ref: src.id, sourceId: src.id, label: clip(src.title, 300), verified: checked(src.summary) };
    const t = this.tables.get(id);
    if (t) return { ...base, kind: "data", ref: t.id, sourceId: t.sourceId || null, label: clip(t.name, 300), verified: checked(t.rows.map((r) => r.join(" ")).join("\n")) };
    const req = this.requirements.get(id);
    if (req) return { ...base, kind: "requirement", ref: id, label: clip(req.title, 300), quote: quote || clip(req.citation ?? "", 300), verified: true };
    if (id === "notes" && this.notes) return { ...base, kind: "note", ref: "notes", label: "Notes", verified: checked(this.notes.scratchpad) };
    return null;
  }

  /** The links for cited ids that were given (unknown ids dropped), deduplicated, at most MAX_EVIDENCE. */
  links(refs: Array<CitedRef | string> | null | undefined, stance: EvidenceLink["stance"] = "neutral"): EvidenceLink[] {
    const out: EvidenceLink[] = [];
    const seen = new Set<string>();
    for (const r of refs ?? []) {
      const l = this.link(typeof r === "string" ? { id: r } : r, stance);
      if (!l || seen.has(`${l.kind}:${l.ref}`)) continue;
      seen.add(`${l.kind}:${l.ref}`);
      out.push(l);
      if (out.length >= MAX_EVIDENCE) break;
    }
    return out;
  }

  /** A location in the document: a known section (or the one whose text holds the quote), and the quote. */
  location(sectionId: string | null | undefined, quote: string | null | undefined): DocLocation | null {
    const q = clip((quote ?? "").trim(), MAX_QUOTE_CHARS);
    let sec = sectionId ? this.sections.get(cleanId(sectionId)) : undefined;
    if (!sec && q) sec = [...this.sections.values()].find((s) => contains(s.text, q) || contains(s.heading, q));
    if (!sec && !q) return null;
    return { sectionId: sec?.sectionId ?? null, specKey: sec?.specKey ?? null, heading: sec?.heading ?? null, quote: q };
  }

  /** Is the quote in the document's text? */
  inDocument(quote: string): boolean {
    return !!this.doc && (contains(this.doc.text, quote) || this.doc.sections.some((s) => contains(s.text, quote)));
  }

  /** Is the quote in any of the given passages (or, with none, any passage shown)? */
  inPassages(quote: string, ids?: string[]): boolean {
    const ps = ids ? ids.map((i) => this.passages.get(i)).filter((p): p is PassageView => !!p) : [...this.passages.values()];
    return ps.some((p) => contains(p.text, quote));
  }
}

/** A section's location, for findings that rest on a whole section. */
export function sectionLocation(s: Pick<SectionView, "sectionId" | "specKey" | "heading">): DocLocation {
  return { sectionId: s.sectionId, specKey: s.specKey, heading: s.heading, quote: "" };
}

// --- Findings ------------------------------------------------------------------------

export const severityRank = (s: Severity) => SEVERITIES.indexOf(s);

export type FindingInput = Partial<Omit<Finding, "id" | "nodeId">> & Pick<Finding, "kind" | "severity" | "title">;

/** Findings for one node, numbered "<nodeId>:<n>" in the order they are added; capped at MAX_FINDINGS. */
export class Findings {
  private readonly out: Finding[] = [];
  constructor(private readonly nodeId: string) {}

  add(f: FindingInput): Finding | null {
    if (this.out.length >= MAX_FINDINGS) return null;
    const finding: Finding = {
      id: `${this.nodeId}:${this.out.length + 1}`,
      nodeId: this.nodeId,
      kind: clip(f.kind, 60),
      severity: f.severity,
      status: f.status ?? null,
      title: clip(f.title.trim() || "Finding", 300),
      detail: clip(f.detail ?? "", 2000),
      location: f.location ?? null,
      evidence: (f.evidence ?? []).slice(0, MAX_EVIDENCE),
      reviewer: f.reviewer ?? null,
      verified: f.verified ?? true,
      fix: clip(f.fix ?? "", 1000),
    };
    this.out.push(finding);
    return finding;
  }

  list(): Finding[] {
    return [...this.out];
  }
}

// --- Statuses --------------------------------------------------------------------------

/** The status spec for a key, or an unverified one when the key isn't configured (trace's unverifiedStatus). */
export function statusFor(statuses: StatusSpec[], key: string): StatusSpec {
  return statuses.find((s) => s.key === key) ?? { key, label: key === "unverified" ? "Unverified" : key.replace(/_/g, " "), ok: false, severity: "minor" };
}

/** The status an item falls to when its cited support doesn't hold: the most severe failing status. */
export function downgradeStatus(statuses: StatusSpec[]): StatusSpec {
  const failing = statuses.filter((s) => !s.ok);
  if (!failing.length) return statuses[statuses.length - 1];
  return failing.reduce((a, b) => (severityRank(b.severity) < severityRank(a.severity) ? b : a));
}

// --- Tables ------------------------------------------------------------------------------

export function outcomeTable(
  key: string,
  title: string,
  columns: Array<{ key: string; label: string }>,
  rows: Array<{ cells: Record<string, string>; status?: string | null; evidence?: EvidenceLink[] }>,
): OutcomeTable {
  return {
    key: clip(key, 80),
    title: clip(title, 200),
    columns: columns.slice(0, 20).map((c) => ({ key: clip(c.key, 60), label: clip(c.label, 120) })),
    rows: rows.slice(0, 500).map((r) => ({
      cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, clip(v, 2000)])),
      status: r.status ?? null,
      evidence: (r.evidence ?? []).slice(0, MAX_EVIDENCE),
    })),
  };
}
