// Applying a change a workflow run proposes (phase6-spec.md §8.2): the open
// editor makes it, as one undo step, after the document is saved and a
// version snapshot is taken. Used by document-screen.tsx through the document
// modal's onApplyWorkflowChange.
//
// - restructure: refused when the document no longer matches the plan's
//   block hashes (applyRestructurePlan's drift check); otherwise the content
//   becomes the plan's result and the document takes the target type
//   (type_source "restructure").
// - replace_section_body: the section is found by sectionId, or by specKey
//   after a restructure. With onlyIfEmpty a section that has text by now is
//   skipped and reported. The body becomes sectionBlocksFromMarkdown of the
//   markdown, with each traced sentence carrying a citation mark per passage
//   behind it and each unsourced sentence highlighted.
// - replace_lines (resume Tailor step, tailor-spec.md §6.1): the caller passes
//   only the lines the author accepted. Each is found again by its text
//   (findLine, the same lookup tailor.lines listed them with); a line edited
//   or removed since the run is skipped and reported, which is the per-line
//   conflict check. Every target is resolved before anything changes. rewrite
//   replaces the paragraph's text (inline formatting on it is lost) and cites
//   the line's master passages; lead moves the list item to the top of its
//   list, rewriting it when the text changed (a line outside a list is skipped:
//   moved to the top of its section it could land under another employer's
//   header); trim removes the list item (and a list left empty), and skips a
//   paragraph a list follows (a job's header: its bullets would be left under
//   the job above). A line repeated in its section is found by which repeat it
//   is (ReplaceLine.occurrence).
//
// planWorkflowChange is pure over ProseMirror JSON (unit-tested); the
// restructure function is passed in, so this module stays independent of the
// workflow-defs track's restructure.ts.

import type { Editor } from "@tiptap/react";
import type { SectionSummary } from "@/catalog/schema";
import { CITATION_MARK, type CitationAttrs } from "@/lib/citations/contract";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import type { DocumentChangeOp, LineResult, ProposedChange, ReplaceLine, RestructurePlan, SentenceTrace } from "@/lib/workflow/contract";
import { documentLines, documentSections, findLine, normalizeLine } from "@/lib/workflow/lines";

/** applyRestructurePlan's shape (src/lib/workflow/restructure.ts). */
export type RestructureFn = (
  doc: PMNode,
  plan: RestructurePlan,
  sections: SectionSummary[],
  newId: () => string,
) => { doc: PMNode; drift: boolean; moved?: unknown; added?: unknown; noHome?: unknown; removed?: unknown };

export type ChangeDeps = {
  /** The target type's sections in outline order, or null when the type isn't available. */
  sectionsFor: (typeKey: string) => SectionSummary[] | null;
  newId: () => string;
  restructure: RestructureFn;
};

export type PlannedChange =
  | {
      ok: true;
      doc: PMNode;
      /** Set by a restructure: the type the document takes. */
      typeKey: string | null;
      /** Ops that changed the document (each replace_lines line counts as one). */
      applied: number;
      /** Why each skipped op was skipped. */
      skipped: string[];
      /** Unsourced sentences highlighted. */
      marked: number;
      /** Headings a restructure removed because they held no text of their own (the plan's `dropped`). */
      removed?: string[];
      /** replace_lines: each line passed in, accepted (changed) or skipped with why. */
      lines?: LineResult[];
    }
  | { ok: false; error: string };

export const DRIFT_ERROR = "The document changed since the plan; run the workflow again.";

const HIGHLIGHT = "highlight";

/** Where a section's own body ends: the next heading at its level or above, or a sub-heading tied to the outline (as listSections' `own`). */
function bodyEnd(nodes: PMNode[], index: number): number {
  const level = Number(nodes[index].attrs?.level ?? 1);
  let j = index + 1;
  while (j < nodes.length) {
    const n = nodes[j];
    if (n.type === "heading" && (Number(n.attrs?.level ?? 1) <= level || n.attrs?.specKey)) break;
    j++;
  }
  return j;
}

/** The top-level index of the op's section heading: by sectionId, else by specKey. */
function findSection(nodes: PMNode[], op: Extract<DocumentChangeOp, { op: "replace_section_body" }>): number {
  const isHeading = (n: PMNode) => n.type === "heading";
  if (op.sectionId) {
    const i = nodes.findIndex((n) => isHeading(n) && n.attrs?.sectionId === op.sectionId);
    if (i >= 0) return i;
  }
  if (op.specKey) return nodes.findIndex((n) => isHeading(n) && n.attrs?.specKey === op.specKey);
  return -1;
}

const INLINE = new Set(["text", "hardBreak"]);
const isTextblock = (n: PMNode) => !!n.content?.length && n.content.every((c) => INLINE.has(c.type));

type Mark = NonNullable<PMNode["marks"]>[number];
/** A sentence and the marks each of its occurrences gets. */
type MarkSpec = { text: string; marks: Mark[] };

const sameMark = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? null) === JSON.stringify(b.attrs ?? null);

/** Add each spec's marks to every occurrence of its sentence inside one textblock, splitting text nodes at the edges. Returns the block and the sentences found in it. */
function markTextblock(block: PMNode, specs: MarkSpec[]): { node: PMNode; hits: string[] } {
  const inline = block.content ?? [];
  const full = inline.map((c) => (c.type === "text" ? (c.text ?? "") : "\n")).join("");
  const ranges: Array<{ from: number; to: number; marks: Mark[] }> = [];
  const hits: string[] = [];
  for (const s of specs) {
    for (let at = full.indexOf(s.text); at >= 0; at = full.indexOf(s.text, at + s.text.length)) ranges.push({ from: at, to: at + s.text.length, marks: s.marks });
    if (full.includes(s.text)) hits.push(s.text);
  }
  if (!ranges.length) return { node: block, hits };
  const out: PMNode[] = [];
  let offset = 0;
  for (const c of inline) {
    if (c.type !== "text" || !c.text) {
      out.push(c);
      if (c.type !== "text") offset += 1;
      continue;
    }
    const text = c.text;
    // Cut points: the range edges that fall inside this text node.
    const cuts = new Set([0, text.length]);
    for (const { from, to } of ranges) {
      if (from > offset && from < offset + text.length) cuts.add(from - offset);
      if (to > offset && to < offset + text.length) cuts.add(to - offset);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      const at = offset + points[k];
      const marks = [...(c.marks ?? [])];
      for (const r of ranges) {
        if (at < r.from || at >= r.to) continue;
        for (const m of r.marks) if (!marks.some((x) => sameMark(x, m))) marks.push(m);
      }
      out.push({ ...c, text: text.slice(points[k], points[k + 1]), ...(marks.length ? { marks } : {}) });
    }
    offset += text.length;
  }
  return { node: { ...block, content: out }, hits };
}

/** Apply `specs` to every textblock in `blocks` (paragraphs, list items, quotes). Returns the blocks and the distinct sentences found. */
function markSentences(blocks: PMNode[], specs: MarkSpec[]): { blocks: PMNode[]; found: Set<string> } {
  const found = new Set<string>();
  if (!specs.length) return { blocks, found };
  const walk = (n: PMNode): PMNode => {
    if (isTextblock(n)) {
      const r = markTextblock(n, specs);
      r.hits.forEach((h) => found.add(h));
      return r.node;
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return { blocks: blocks.map(walk), found };
}

/** Highlight the unsourced sentences in inserted blocks (paragraphs, list items, quotes). `marked` counts the distinct sentences found. */
export function markUnsourced(blocks: PMNode[], sentences: string[]): { blocks: PMNode[]; marked: number } {
  const wanted = [...new Set(sentences.map((s) => s.trim()).filter(Boolean))];
  const r = markSentences(blocks, wanted.map((text) => ({ text, marks: [{ type: HIGHLIGHT }] })));
  return { blocks: r.blocks, marked: r.found.size };
}

/**
 * Cite each traced sentence's passages (phase7-spec.md §2.3): a citation mark
 * per passage support on the sentence's text, as the generate path does for
 * markers. The support was checked against the grounding by traceDraft, so the
 * marks are verified. `cited` counts the distinct sentences found.
 */
export function markSupported(blocks: PMNode[], trace: SentenceTrace[]): { blocks: PMNode[]; cited: number } {
  const specs: MarkSpec[] = [];
  for (const t of trace) {
    const text = t.text.trim();
    const marks: Mark[] = t.support
      .filter((e) => e.kind === "passage" && e.ref)
      .map((e) => {
        const attrs: CitationAttrs = { kind: "passage", passageId: e.ref, sourceId: e.sourceId, dataTableId: null, quote: null, verified: e.verified };
        return { type: CITATION_MARK, attrs };
      });
    if (text && marks.length) specs.push({ text, marks });
  }
  const r = markSentences(blocks, specs);
  return { blocks: r.blocks, cited: r.found.size };
}

// --- replace_lines ----------------------------------------------------------------

/** A line's skip detail when the editor no longer finds it. */
export const LINE_GONE = "No longer in the document (edited since the run)";
/** A trim of a list item's first paragraph when sub-items hang under it (removing the item would remove lines nobody chose). */
export const LINE_HAS_ITEMS = "It has items under it, so it wasn't trimmed";
/** A lead of a line outside a list (tailor.lines never proposes one; a stored run may). */
export const LINE_NOT_IN_LIST = "It isn't in a list, so it wasn't moved";
const SKIP_REASON: Record<string, string> = { [LINE_GONE]: "edited since the run", [LINE_HAS_ITEMS]: "items under it", [LINE_NOT_IN_LIST]: "not in a list" };

const LIST_ITEMS = new Set(["listItem", "taskItem"]);
const ACCEPTED: Record<ReplaceLine["action"], string> = { rewrite: "Rewritten", lead: "Moved to the top", trim: "Trimmed" };

/** A resolved line: the paragraph's ancestors from the doc down to it, and whether it sits in a list. */
type LineTarget = { line: ReplaceLine; chain: PMNode[]; inList: boolean };

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

const removeChild = (parent: PMNode, child: PMNode) => {
  parent.content = (parent.content ?? []).filter((c) => c !== child);
};

/** Remove the line (its list item when the paragraph is the item's only content); containers left empty go too. Null, or why it was skipped. */
function trimLine(doc: PMNode, chain: PMNode[]): string | null {
  const para = chain[chain.length - 1];
  let at = chain.length - 1;
  const parent = chain[at - 1];
  // A paragraph a list follows heads it (a job's header line): its bullets would be left under the entry above.
  const siblings = parent.content ?? [];
  if (!LIST_ITEMS.has(parent.type) && LISTS.has(siblings[siblings.indexOf(para) + 1]?.type ?? "")) return LINE_HAS_ITEMS;
  if (LIST_ITEMS.has(parent.type)) {
    const kids = parent.content ?? [];
    if (kids.length === 1) at -= 1;
    // A list item opens with a paragraph: only drop its first one when another paragraph can take its place.
    else if (kids[0] === para && kids[1]?.type !== "paragraph") return LINE_HAS_ITEMS;
  }
  removeChild(chain[at - 1], chain[at]);
  for (let i = at - 1; i > 0 && !chain[i].content?.length; i--) removeChild(chain[i - 1], chain[i]);
  if (!doc.content?.length) doc.content = [{ type: "paragraph" }];
  return null;
}

/** Move the line's list item to the top of its list. */
function leadLine(t: LineTarget) {
  const item = t.chain.findLastIndex((n, i) => i > 0 && LIST_ITEMS.has(n.type));
  const [parent, node] = [t.chain[item - 1], t.chain[item]];
  removeChild(parent, node);
  parent.content = [node, ...(parent.content ?? [])];
}

/** The paragraph's text becomes `proposed` (attrs kept), with a citation mark per master passage behind it. */
function rewriteLine(para: PMNode, line: ReplaceLine) {
  const text = line.proposed.trim();
  const { blocks } = markSupported([{ ...para, content: [{ type: "text", text }] }], [{ text, support: line.evidence, unsourced: false }]);
  para.content = blocks[0].content;
}

/**
 * Pure: the document with `lines` applied (only the lines the author
 * accepted). Every line is found against the document as it is now before
 * anything changes; the edits then work on node identity, so a move or a
 * removal never shifts another line's target. Leads run last line first, so
 * the first listed ends up on top.
 */
export function applyLines(doc: PMNode, lines: ReplaceLine[]): { doc: PMNode; results: LineResult[]; changed: number } {
  const next = structuredClone(doc);
  const found = documentLines(next);
  const sections = documentSections(next);
  const used = new Set<string>();
  const results = new Map<string, LineResult>();
  const targets: LineTarget[] = [];
  for (const line of lines) {
    const hit = findLine(found, line, { sections, used });
    if (!hit) {
      results.set(line.id, { lineId: line.id, result: "skipped", detail: LINE_GONE });
      continue;
    }
    used.add(hit.ref);
    const chain: PMNode[] = [next];
    for (const i of hit.path) chain.push(chain[chain.length - 1].content![i]);
    targets.push({ line, chain, inList: hit.inList });
  }
  let changed = 0;
  for (const t of [...targets].reverse()) {
    const { line } = t;
    const para = t.chain[t.chain.length - 1];
    if (line.action === "trim") {
      const why = trimLine(next, t.chain);
      results.set(line.id, why ? { lineId: line.id, result: "skipped", detail: why } : { lineId: line.id, result: "accepted", detail: ACCEPTED.trim });
      if (!why) changed++;
      continue;
    }
    if (line.action === "lead" && !t.inList) {
      results.set(line.id, { lineId: line.id, result: "skipped", detail: LINE_NOT_IN_LIST });
      continue;
    }
    if (line.action === "lead") leadLine(t);
    const rewrite = !!line.proposed.trim() && normalizeLine(line.proposed) !== normalizeLine(line.original);
    if (rewrite) rewriteLine(para, line);
    results.set(line.id, { lineId: line.id, result: "accepted", detail: line.action === "lead" && rewrite ? "Moved to the top and rewritten" : ACCEPTED[line.action] });
    changed++;
  }
  return { doc: next, results: lines.map((l) => results.get(l.id)!), changed };
}

/** The document after `change`, or why it can't be applied. Pure. */
export function planWorkflowChange(doc: PMNode, change: Pick<ProposedChange, "ops">, deps: ChangeDeps): PlannedChange {
  let current: PMNode = { ...doc, content: [...(doc.content ?? [])] };
  let typeKey: string | null = null;
  let applied = 0;
  let marked = 0;
  const skipped: string[] = [];
  const removed: string[] = [];
  const lines: LineResult[] = [];
  const hasLines = change.ops.some((op) => op.op === "replace_lines");
  for (const op of change.ops) {
    if (op.op === "restructure") {
      const sections = deps.sectionsFor(op.plan.targetType);
      if (!sections) return { ok: false, error: `The type “${op.plan.targetTitle || op.plan.targetType}” isn't available to this team.` };
      const r = deps.restructure(current, op.plan, sections, deps.newId);
      if (r.drift) return { ok: false, error: DRIFT_ERROR };
      current = r.doc;
      if (typeof r.removed === "number" && r.removed > 0) removed.push(...(op.plan.dropped ?? []).map((d) => d.heading));
      typeKey = op.plan.targetType;
      applied++;
      continue;
    }
    if (op.op === "replace_lines") {
      const r = applyLines(current, op.lines);
      current = r.doc;
      lines.push(...r.results);
      applied += r.changed;
      continue;
    }
    const nodes = current.content ?? [];
    const index = findSection(nodes, op);
    const name = op.heading || "Untitled section";
    if (index < 0) {
      skipped.push(`“${name}” is no longer in the document.`);
      continue;
    }
    if (op.onlyIfEmpty && listSections(current, { own: true }).find((s) => s.index === index)?.hasContent) {
      skipped.push(`“${name}” has text now, so its draft wasn't inserted.`);
      continue;
    }
    const level = Number(nodes[index].attrs?.level ?? op.level ?? 2);
    const unsourced = op.trace.filter((t) => t.unsourced).map((t) => t.text);
    const cited = markSupported(sectionBlocksFromMarkdown(op.markdown, level), op.trace);
    const { blocks, marked: m } = markUnsourced(cited.blocks, unsourced);
    marked += m;
    current = { ...current, content: [...nodes.slice(0, index + 1), ...blocks, ...nodes.slice(bodyEnd(nodes, index))] };
    applied++;
  }
  return { ok: true, doc: current, typeKey, applied, skipped, marked, ...(removed.length ? { removed } : {}), ...(hasLines ? { lines } : {}) };
}

/**
 * What happened, for the notice and the `changes` POST. result null: refused (nothing changed,
 * nothing to record). `lines`: replace_lines' per-line results. `unsaved`: the lines are in the
 * editor but the save after them didn't land (a conflict or a failure), so the stored document,
 * which a waiting run reads next, doesn't hold them yet: the caller holds the POST until it does.
 */
export type AppliedChange = { result: "applied" | "skipped" | null; detail: string; typeKey: string | null; lines?: LineResult[]; unsaved?: boolean };

/** Why line changes aren't applied over a save that already failed. */
export const SAVE_FIRST = "The document has changes that aren't saved (a save conflicted or failed). Resolve that, then apply the lines.";

/** "Changed 4 lines; 1 skipped (edited since the run)." */
export function linesDetail(results: LineResult[]): string {
  const changed = results.filter((r) => r.result === "accepted").length;
  const skipped = results.filter((r) => r.result === "skipped");
  const head = changed ? `Changed ${changed} line${changed === 1 ? "" : "s"}` : "No lines were changed";
  if (!skipped.length) return `${head}.`;
  const why = [...new Set(skipped.map((r) => SKIP_REASON[r.detail] ?? r.detail))].filter(Boolean).join("; ");
  return `${head}; ${skipped.length} skipped${why ? ` (${why})` : ""}.`;
}

/** One line for the notice and the change record. */
export function changeDetail(p: Extract<PlannedChange, { ok: true }>): string {
  const ops = p.applied - (p.lines?.filter((r) => r.result === "accepted").length ?? 0);
  const parts: string[] = [];
  if (p.lines) parts.push(linesDetail(p.lines));
  if (!p.lines || ops) parts.push(ops ? `${ops} change${ops === 1 ? "" : "s"} made.` : "Nothing was changed.");
  if (p.removed?.length) parts.push(`Removed ${p.removed.length} heading${p.removed.length === 1 ? "" : "s"} with no text of ${p.removed.length === 1 ? "its" : "their"} own: ${p.removed.map((h) => `“${h}”`).join(", ")}.`);
  if (p.marked) parts.push(`${p.marked} unsourced sentence${p.marked === 1 ? " is" : "s are"} highlighted.`);
  parts.push(...p.skipped);
  return parts.join(" ");
}

/**
 * Apply `change` in the editor: save, snapshot, then replace the content in a
 * single transaction (one undo step). The caller sets the type and shows the
 * notice.
 */
export async function applyWorkflowChange(
  editor: Editor,
  change: ProposedChange,
  deps: ChangeDeps & { ensureSaved: () => Promise<string | null>; snapshot: (reason: string) => Promise<void>; isSaved?: () => boolean },
): Promise<AppliedChange> {
  await deps.ensureSaved();
  const hasLines = change.ops.some((op) => op.op === "replace_lines");
  if (hasLines && deps.isSaved && !deps.isSaved()) return { result: null, detail: SAVE_FIRST, typeKey: null };
  const planned = planWorkflowChange(editor.getJSON() as PMNode, change, deps);
  if (!planned.ok) return { result: null, detail: planned.error, typeKey: null };
  const lines = planned.lines ? { lines: planned.lines } : {};
  if (!planned.applied) return { result: "skipped", detail: changeDetail(planned), typeKey: null, ...lines };
  await deps.snapshot(change.snapshotReason || `Before “${change.title}”`);
  if (editor.isDestroyed) return { result: null, detail: "The editor closed before the change was made.", typeKey: null };
  const { state } = editor;
  const next = state.schema.nodeFromJSON(planned.doc);
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, next.content).scrollIntoView());
  // A waiting run resumes as soon as the result is posted and reads the stored
  // document fresh (tailor-spec.md §1, doc2): save the applied lines first, and
  // say so when that save didn't land (flush resolves to the id either way).
  if (planned.lines) await deps.ensureSaved();
  const unsaved = !!planned.lines && !!deps.isSaved && !deps.isSaved();
  return { result: "applied", detail: changeDetail(planned), typeKey: planned.typeKey, ...lines, ...(unsaved ? { unsaved: true } : {}) };
}
