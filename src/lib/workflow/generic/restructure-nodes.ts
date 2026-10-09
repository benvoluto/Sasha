// The restructure nodes (phase6-spec.md §3): plan (the model maps each part of
// the document onto the target type's sections), apply (the checkpoint's edits
// laid over the plan, as one change the editor applies), and rewrite (rewrite
// mode only: reword one restructured section, adding only transitional prose).
// The text itself is moved by applyRestructurePlan (../restructure.ts), in code.

import { getType } from "@/catalog";
import { sortedSections, type DocumentTypeDefinition } from "@/catalog/schema";
import { listSections, nodeText, type PMNode } from "@/lib/documents/sections";
import { claudeJson, claudeText } from "@/lib/llm/claude";
import { stripFences } from "@/lib/sections/prompt";
import { NO_HOME_HEADING, type CheckpointDecision, type DocumentChangeOp, type RestructureDroppedHeading, type RestructurePlan, type RestructureRow } from "../contract";
import { NodeError, type NodeContext, type NodeHandler } from "../context";
import { asDoc, callOpts, clip, Findings, flat, outcomeTable } from "../nodes/util";
import { applyRestructurePlan, blockHashes, droppedWarning, restructureChunks, type RestructureChunk } from "../restructure";
import { RESTRUCTURE_PLAN_SYSTEM, RESTRUCTURE_REWRITE_SYSTEM, RestructurePlanReply, REWRITE_CHARS, restructurePlanPrompt, restructureRewritePrompt } from "./prompts";
import { numbersIn } from "./compute";

/** A section rewrite mode hands to restructure.rewrite: the target section and the text moved into it. */
export type RewriteSection = { specKey: string; heading: string; level: number; text: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function targetType(ctx: NodeContext, key: string | undefined): Promise<DocumentTypeDefinition> {
  if (!key) throw new NodeError("choose a type to restructure to");
  const entry = await getType(ctx.teamId, key);
  if (!entry || !entry.enabled) throw new NodeError(`the type “${key}” is not available`);
  return entry.definition;
}

// --- Plan --------------------------------------------------------------------------

/** Pure: rows from the model's reply. Every part gets a row; unknown keys and missing rows become no home. */
export function planRows(chunks: RestructureChunk[], reply: RestructurePlanReply, keys: Set<string>): RestructureRow[] {
  const byId = new Map(reply.rows.map((r) => [r.id.trim().toUpperCase(), r]));
  return chunks.map((c, i) => {
    const id = `R${i + 1}`;
    const r = byId.get(id);
    const target = r?.target && keys.has(r.target.trim()) ? r.target.trim() : null;
    const reason = !r ? "Not mapped by the planner." : r.target && !target ? `No such section “${clip(r.target, 60)}”; kept under “${NO_HOME_HEADING}”.` : clip(r.reason.trim(), 500);
    return { id, from: c.from, to: c.to, heading: c.heading, excerpt: c.excerpt, target, reason };
  });
}

/**
 * Pure: is the document already in the target's order? Every part with a heading
 * already sits in its target (the heading carries that spec key), targets run
 * in outline order, nothing lacks a home and no section is missing.
 */
export function alreadyInOrder(rows: RestructureRow[], gaps: string[], order: string[], headingKeys: Array<string | null>): boolean {
  if (gaps.length) return false;
  let last = -1;
  for (const [i, r] of rows.entries()) {
    if (r.heading === null && r.target === null) continue;
    if (r.target === null || headingKeys[i] !== r.target) return false;
    const at = order.indexOf(r.target);
    if (at < last) return false;
    last = at;
  }
  return true;
}

/** Pure: the parts that are only a heading (Phase 8): left out of the prompt and the rows, removed on apply. */
export function droppedHeadings(chunks: RestructureChunk[]): RestructureDroppedHeading[] {
  return chunks.filter((c) => c.headingOnly && c.heading !== null).map((c) => ({ index: c.from, heading: c.heading!, level: c.level ?? 2 }));
}

export function mappingTable(nodeId: string, plan: RestructurePlan, def: Pick<DocumentTypeDefinition, "sections">) {
  const heading = new Map(def.sections.map((s) => [s.key, s.heading]));
  return outcomeTable(
    `${nodeId}:mapping`,
    `Restructure to ${plan.targetTitle}`,
    [
      { key: "id", label: "Row" },
      { key: "part", label: "Part" },
      { key: "excerpt", label: "Excerpt" },
      { key: "target", label: "Moves to" },
      { key: "why", label: "Why" },
    ],
    [
      ...plan.rows.map((r) => ({
        cells: {
          id: r.id,
          part: r.heading ?? "Text before the first heading",
          excerpt: r.excerpt,
          target: r.target ? (heading.get(r.target) ?? r.target) : `No home: kept word for word under “${NO_HOME_HEADING}”`,
          why: r.reason,
        },
        status: r.target ? "mapped" : "no_home",
      })),
      ...plan.gaps.map((k) => ({ cells: { id: "", part: "", excerpt: "", target: heading.get(k) ?? k, why: "Will be added empty" }, status: "gap" })),
      ...(plan.dropped ?? []).map((x) => ({ cells: { id: "", part: x.heading, excerpt: "", target: "Removed", why: "This heading holds no text of its own." }, status: "dropped" })),
    ],
  );
}

export const restructurePlanHandler: NodeHandler = async (inputs, node, ctx) => {
  const id = node.node.id;
  const def = await targetType(ctx, ctx.run.params.targetType);
  const mode = ctx.run.params.mode ?? (node.config.mode as "merge" | "rewrite");
  const record = await ctx.document();
  const d = asDoc(inputs.document);
  const all = restructureChunks(record.content_json);
  const dropped = droppedHeadings(all);
  const chunks = all.filter((c) => !c.headingOnly);
  const outline = sortedSections(def.sections);
  const keys = new Set(outline.map((s) => s.key));

  let rows: RestructureRow[] = [];
  if (chunks.length) {
    const { data } = await claudeJson({
      task: "restructure.plan",
      system: RESTRUCTURE_PLAN_SYSTEM,
      user: restructurePlanPrompt({ title: d?.title ?? record.title, targetTitle: def.title, sections: outline, chunks }),
      schema: RestructurePlanReply,
      ...callOpts(ctx),
    });
    rows = planRows(chunks, data, keys);
  }
  const used = new Set(rows.map((r) => r.target).filter(Boolean));
  const gaps = outline.filter((s) => !used.has(s.key)).map((s) => s.key);
  const plan: RestructurePlan = { targetType: def.key, targetTitle: def.title, mode, basisUpdatedAt: record.updated_at, blockHashes: blockHashes(record.content_json), rows, gaps, dropped };

  const nodes = record.content_json.content ?? [];
  const headingKeys = rows.map((r) => (r.heading !== null ? ((nodes[r.from]?.attrs?.specKey as string | null | undefined) ?? null) : null));
  const findings = new Findings(id);
  // A dropped heading that already carries a gap section's key is that section, still empty: in order,
  // not missing. Any other dropped heading goes when applied, so the document is not already in order.
  const keyAt = (x: RestructureDroppedHeading) => (nodes[x.index]?.attrs?.specKey as string | null | undefined) ?? null;
  const droppedHeld = dropped.every((x) => gaps.includes(keyAt(x) ?? ""));
  const heldGaps = gaps.filter((k) => !dropped.some((x) => keyAt(x) === k));
  if (dropped.length) {
    findings.add({
      kind: "dropped_heading",
      severity: "minor",
      title: `${dropped.length} heading${dropped.length === 1 ? "" : "s"} with no text of ${dropped.length === 1 ? "its" : "their"} own will be removed`,
      detail: `${droppedWarning(dropped)} A heading that reads as a section of the ${def.title} outline gives that section its place.`,
    });
  }
  if (droppedHeld && alreadyInOrder(rows, heldGaps, outline.map((s) => s.key), headingKeys)) {
    findings.add({ kind: "no_change", severity: "info", title: `Already in the ${def.title} order`, detail: "Every part already sits in its section, in outline order, and no section is missing." });
  }
  const sectionsById = new Map(listSections(record.content_json).map((s) => [s.index, s]));
  for (const r of rows.filter((x) => x.target === null && x.heading !== null)) {
    const s = sectionsById.get(r.from);
    findings.add({
      kind: "no_home",
      severity: "info",
      title: `No home for “${clip(r.heading ?? "", 120)}”`,
      detail: `Kept word for word under “${NO_HOME_HEADING}”. ${r.reason}`,
      location: s ? { sectionId: s.sectionId || null, specKey: s.specKey, heading: s.heading, quote: "" } : null,
    });
  }
  for (const k of gaps) findings.add({ kind: "empty_section", severity: "info", title: `“${outline.find((s) => s.key === k)?.heading ?? k}” will be added empty`, detail: "No part of the document maps to this section." });

  return { plan, rows, findings: findings.list(), table: mappingTable(id, plan, def) };
};

// --- Apply ---------------------------------------------------------------------------

/** Pure: the plan with the checkpoint's target edits laid over it (unknown rows ignored; unknown keys become no home), gaps recomputed. */
export function editedPlan(plan: RestructurePlan, decision: CheckpointDecision | null, keys: string[]): RestructurePlan {
  const targets = decision?.edits?.targets ?? {};
  const known = new Set(keys);
  const rows = plan.rows.map((r) => (r.id in targets ? { ...r, target: targets[r.id] && known.has(targets[r.id]!) ? targets[r.id] : null, reason: r.target === targets[r.id] ? r.reason : "Changed at the checkpoint." } : r));
  const used = new Set(rows.map((r) => r.target).filter(Boolean));
  return { ...plan, rows, gaps: keys.filter((k) => !used.has(k)) };
}

const asPlan = (v: unknown): RestructurePlan | null => {
  const p = flat(v)[0];
  return isObj(p) && Array.isArray(p.rows) && Array.isArray(p.blockHashes) ? (p as unknown as RestructurePlan) : null;
};
const asDecision = (v: unknown): CheckpointDecision | null => {
  const d = flat(v)[0];
  return isObj(d) && typeof d.verdict === "string" ? (d as unknown as CheckpointDecision) : null;
};

/** Pure: a section's own body as text, its kept sub-headings marked as Markdown headings so the rewrite keeps them as headings. */
export function ownBodyMarkdown(doc: PMNode, index: number, level: number): string {
  const nodes = doc.content ?? [];
  let out = "";
  for (let i = index + 1; i < nodes.length; i++) {
    const n = nodes[i];
    const l = Number(n.attrs?.level ?? 1);
    if (n.type === "heading" && (l <= level || n.attrs?.specKey)) break;
    out += n.type === "heading" ? `${"#".repeat(Math.min(Math.max(l, 3), 6))} ${nodeText(n).trim()}\n` : nodeText(n);
  }
  return out.trim();
}

export const restructureApplyHandler: NodeHandler = async (inputs, _node, ctx) => {
  const base = asPlan(inputs.plan);
  if (!base) throw new NodeError("no restructure plan to apply");
  const def = await targetType(ctx, base.targetType);
  const outline = sortedSections(def.sections);
  const plan = editedPlan(base, asDecision(inputs.decision), outline.map((s) => s.key));
  const op: DocumentChangeOp = { op: "restructure", plan };
  if (plan.mode !== "rewrite") return { op, sections: [] };

  // Rewrite mode: the text each section will hold once moved, for rewording one section at a time.
  const record = await ctx.document();
  const moved = applyRestructurePlan(record.content_json, plan, outline);
  if (moved.drift) throw new NodeError("The document changed since the plan; run the workflow again.");
  const filled = new Set(plan.rows.map((r) => r.target).filter(Boolean));
  // The rewrite replaces the section's whole own body but sees only its plain
  // text, so a section holding a table, image or rule (or more text than the
  // model is shown) stays as moved rather than lose what the model never saw.
  const sections: RewriteSection[] = listSections(moved.doc, { own: true })
    .filter((s) => s.specKey && filled.has(s.specKey) && s.bodyText.trim() && !s.media && s.bodyText.length <= REWRITE_CHARS)
    .map((s) => ({ specKey: s.specKey!, heading: s.heading, level: s.level, text: ownBodyMarkdown(moved.doc, s.index, s.level) }));
  return { op, sections };
};

// --- Rewrite -----------------------------------------------------------------------------

/** Pure: numbers `after` has that `before` did not (a rewrite may add no figures; swapped, the figures it lost). */
export function addedNumbers(before: string, after: string): string[] {
  const had = new Set(numbersIn(before));
  return [...new Set(numbersIn(after))].filter((n) => !had.has(n));
}

const asSection = (v: unknown): RewriteSection | null => {
  const s = flat(v)[0];
  return isObj(s) && typeof s.specKey === "string" && typeof s.text === "string" ? (s as unknown as RewriteSection) : null;
};

export const restructureRewriteHandler: NodeHandler = async (inputs, _node, ctx) => {
  const section = asSection(inputs.section);
  if (!section || !section.text.trim()) return { op: null };
  const def = ctx.run.params.targetType ? (await getType(ctx.teamId, ctx.run.params.targetType))?.definition ?? null : null;
  const spec = def?.sections.find((s) => s.key === section.specKey) ?? null;
  const { text } = await claudeText({
    task: "restructure.apply",
    system: RESTRUCTURE_REWRITE_SYSTEM,
    user: restructureRewritePrompt({ heading: section.heading, text: section.text, targetTitle: def?.title ?? "Document", spec }),
    ...callOpts(ctx),
  });
  const markdown = stripFences(text);
  if (!markdown) throw new NodeError(`the rewrite of “${section.heading}” came back empty`);
  // A rewrite that adds figures has added claims, and one that loses figures
  // has dropped facts: either way keep the moved text as it is rather than apply it.
  const added = addedNumbers(section.text, markdown);
  const dropped = addedNumbers(markdown, section.text);
  if (added.length || dropped.length) {
    // Counts and the spec key only: the figures and heading are document text, and server logs are not team-scoped.
    console.warn(`[workflow] restructure.rewrite dropped for specKey=${section.specKey}: ${added.length} new, ${dropped.length} lost numbers`);
    return { op: null };
  }
  const op: DocumentChangeOp = { op: "replace_section_body", sectionId: null, specKey: section.specKey, heading: section.heading, level: section.level, markdown, onlyIfEmpty: false, trace: [] };
  return { op };
};
