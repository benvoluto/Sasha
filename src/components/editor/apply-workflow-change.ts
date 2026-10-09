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
//
// planWorkflowChange is pure over ProseMirror JSON (unit-tested); the
// restructure function is passed in, so this module stays independent of the
// workflow-defs track's restructure.ts.

import type { Editor } from "@tiptap/react";
import type { SectionSummary } from "@/catalog/schema";
import { CITATION_MARK, type CitationAttrs } from "@/lib/citations/contract";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import type { DocumentChangeOp, ProposedChange, RestructurePlan, SentenceTrace } from "@/lib/workflow/contract";

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
      /** Ops that changed the document. */
      applied: number;
      /** Why each skipped op was skipped. */
      skipped: string[];
      /** Unsourced sentences highlighted. */
      marked: number;
      /** Headings a restructure removed because they held no text of their own (the plan's `dropped`). */
      removed?: string[];
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

/** The document after `change`, or why it can't be applied. Pure. */
export function planWorkflowChange(doc: PMNode, change: Pick<ProposedChange, "ops">, deps: ChangeDeps): PlannedChange {
  let current: PMNode = { ...doc, content: [...(doc.content ?? [])] };
  let typeKey: string | null = null;
  let applied = 0;
  let marked = 0;
  const skipped: string[] = [];
  const removed: string[] = [];
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
  return { ok: true, doc: current, typeKey, applied, skipped, marked, ...(removed.length ? { removed } : {}) };
}

/** What happened, for the notice and the `changes` POST. result null: refused (nothing changed, nothing to record). */
export type AppliedChange = { result: "applied" | "skipped" | null; detail: string; typeKey: string | null };

/** One line for the notice and the change record. */
export function changeDetail(p: Extract<PlannedChange, { ok: true }>): string {
  const parts = [p.applied ? `${p.applied} change${p.applied === 1 ? "" : "s"} made.` : "Nothing was changed."];
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
  deps: ChangeDeps & { ensureSaved: () => Promise<string | null>; snapshot: (reason: string) => Promise<void> },
): Promise<AppliedChange> {
  await deps.ensureSaved();
  const planned = planWorkflowChange(editor.getJSON() as PMNode, change, deps);
  if (!planned.ok) return { result: null, detail: planned.error, typeKey: null };
  if (!planned.applied) return { result: "skipped", detail: changeDetail(planned), typeKey: null };
  await deps.snapshot(change.snapshotReason || `Before “${change.title}”`);
  if (editor.isDestroyed) return { result: null, detail: "The editor closed before the change was made.", typeKey: null };
  const { state } = editor;
  const next = state.schema.nodeFromJSON(planned.doc);
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, next.content).scrollIntoView());
  return { result: "applied", detail: changeDetail(planned), typeKey: planned.typeKey };
}
