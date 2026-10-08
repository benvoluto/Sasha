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
//   markdown, with each unsourced sentence highlighted.
//
// planWorkflowChange is pure over ProseMirror JSON (unit-tested); the
// restructure function is passed in, so this module stays independent of the
// workflow-defs track's restructure.ts.

import type { Editor } from "@tiptap/react";
import type { SectionSummary } from "@/catalog/schema";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import type { DocumentChangeOp, ProposedChange, RestructurePlan } from "@/lib/workflow/contract";

/** applyRestructurePlan's shape (src/lib/workflow/restructure.ts). */
export type RestructureFn = (
  doc: PMNode,
  plan: RestructurePlan,
  sections: SectionSummary[],
  newId: () => string,
) => { doc: PMNode; drift: boolean; moved?: unknown; added?: unknown; noHome?: unknown };

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

/** Highlight each occurrence of `sentences` inside one textblock, splitting text nodes at the edges. Returns the block and the sentences found in it. */
function markTextblock(block: PMNode, sentences: string[]): { node: PMNode; hits: string[] } {
  const inline = block.content ?? [];
  const full = inline.map((c) => (c.type === "text" ? (c.text ?? "") : "\n")).join("");
  const ranges: Array<[number, number]> = [];
  const hits: string[] = [];
  for (const s of sentences) {
    for (let at = full.indexOf(s); at >= 0; at = full.indexOf(s, at + s.length)) ranges.push([at, at + s.length]);
    if (full.includes(s)) hits.push(s);
  }
  if (!ranges.length) return { node: block, hits };
  const inRange = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
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
    for (const [a, b] of ranges) {
      if (a > offset && a < offset + text.length) cuts.add(a - offset);
      if (b > offset && b < offset + text.length) cuts.add(b - offset);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      const marks = c.marks ?? [];
      const highlight = inRange(offset + points[k]) && !marks.some((m) => m.type === HIGHLIGHT);
      out.push({ ...c, text: text.slice(points[k], points[k + 1]), ...(highlight ? { marks: [...marks, { type: HIGHLIGHT }] } : {}) });
    }
    offset += text.length;
  }
  return { node: { ...block, content: out }, hits };
}

/** Highlight the unsourced sentences in inserted blocks (paragraphs, list items, quotes). `marked` counts the distinct sentences found. */
export function markUnsourced(blocks: PMNode[], sentences: string[]): { blocks: PMNode[]; marked: number } {
  const wanted = [...new Set(sentences.map((s) => s.trim()).filter(Boolean))];
  if (!wanted.length) return { blocks, marked: 0 };
  const found = new Set<string>();
  const walk = (n: PMNode): PMNode => {
    if (isTextblock(n)) {
      const r = markTextblock(n, wanted);
      r.hits.forEach((h) => found.add(h));
      return r.node;
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return { blocks: blocks.map(walk), marked: found.size };
}

/** The document after `change`, or why it can't be applied. Pure. */
export function planWorkflowChange(doc: PMNode, change: Pick<ProposedChange, "ops">, deps: ChangeDeps): PlannedChange {
  let current: PMNode = { ...doc, content: [...(doc.content ?? [])] };
  let typeKey: string | null = null;
  let applied = 0;
  let marked = 0;
  const skipped: string[] = [];
  for (const op of change.ops) {
    if (op.op === "restructure") {
      const sections = deps.sectionsFor(op.plan.targetType);
      if (!sections) return { ok: false, error: `The type “${op.plan.targetTitle || op.plan.targetType}” isn't available to this team.` };
      const r = deps.restructure(current, op.plan, sections, deps.newId);
      if (r.drift) return { ok: false, error: DRIFT_ERROR };
      current = r.doc;
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
    const { blocks, marked: m } = markUnsourced(sectionBlocksFromMarkdown(op.markdown, level), unsourced);
    marked += m;
    current = { ...current, content: [...nodes.slice(0, index + 1), ...blocks, ...nodes.slice(bodyEnd(nodes, index))] };
    applied++;
  }
  return { ok: true, doc: current, typeKey, applied, skipped, marked };
}

/** What happened, for the notice and the `changes` POST. result null: refused (nothing changed, nothing to record). */
export type AppliedChange = { result: "applied" | "skipped" | null; detail: string; typeKey: string | null };

/** One line for the notice and the change record. */
export function changeDetail(p: Extract<PlannedChange, { ok: true }>): string {
  const parts = [p.applied ? `${p.applied} change${p.applied === 1 ? "" : "s"} made.` : "Nothing was changed."];
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
