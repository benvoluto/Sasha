// Follows a selected range through the edits made while a slow operation (a
// rewrite can take a couple of minutes) runs, so its result lands where the
// text now is, or not at all if that text was changed or removed. Section
// generation instead re-finds its target by section id (sectionBodyRange).

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Mapping } from "@tiptap/pm/transform";
import { sectionRange } from "./extensions";

export type TextRange = { from: number; to: number; text: string };

/**
 * Where `range` is now, after the steps in `mapping`, or null if it was deleted
 * or its text no longer reads the same. Text typed at either edge stays outside
 * the range.
 */
export function mapRange(mapping: Mapping, doc: PMNode, range: TextRange): { from: number; to: number } | null {
  const start = mapping.mapResult(range.from, 1);
  const end = mapping.mapResult(range.to, -1);
  if (start.deletedAcross && end.deletedAcross && start.pos >= end.pos) return null;
  if (end.pos <= start.pos || end.pos > doc.content.size) return null;
  if (doc.textBetween(start.pos, end.pos, "\n\n").trim() !== range.text.trim()) return null;
  return { from: start.pos, to: end.pos };
}

/** Start following `range` in the editor. Call `current()` for its position now and `stop()` when done. */
export function trackRange(editor: Editor, range: TextRange) {
  const mapping = new Mapping();
  const onTransaction = ({ transaction }: { transaction: { mapping: Mapping } }) => mapping.appendMapping(transaction.mapping);
  editor.on("transaction", onTransaction);
  return {
    current: () => (editor.isDestroyed ? null : mapRange(mapping, editor.state.doc, range)),
    stop: () => {
      editor.off("transaction", onTransaction);
    },
  };
}

export type SectionBody = {
  /** Position of the section's heading node. */
  headingPos: number;
  level: number;
  specKey: string | null;
  heading: string;
  /** The body: from just after the heading to the end of the section. */
  from: number;
  to: number;
  /** The body as plain text, blocks separated by blank lines. */
  bodyText: string;
};

/**
 * The body of the section whose heading carries `sectionId`, or null if no
 * top-level heading does. The body runs to the next heading at the same or a
 * higher level (sectionRange), but stops early at a sub-heading that carries a
 * `specKey`: that is a section of its own in the document's type (NIH's
 * Significance under Research Strategy), so drafting the parent never replaces it.
 */
export function sectionBodyRange(doc: PMNode, sectionId: string): SectionBody | null {
  let headingPos = -1;
  doc.forEach((node, pos) => {
    if (headingPos < 0 && node.type.name === "heading" && node.attrs.sectionId === sectionId) headingPos = pos;
  });
  if (headingPos < 0) return null;
  const heading = doc.nodeAt(headingPos)!;
  const from = headingPos + heading.nodeSize;
  const end = sectionRange(doc, headingPos).to;
  let to = end;
  doc.forEach((node, pos) => {
    if (to === end && pos >= from && pos < end && node.type.name === "heading" && node.attrs.specKey) to = pos;
  });
  return {
    headingPos,
    level: Number(heading.attrs.level ?? 2),
    specKey: (heading.attrs.specKey as string | null) || null,
    heading: heading.textContent,
    from,
    to,
    bodyText: to > from ? doc.textBetween(from, to, "\n\n") : "",
  };
}

/**
 * Where to put the caret after a section's body was replaced while the caret
 * was inside it: the end of the new body, so it stays in that section (mapped
 * through the replacement it would land past it, in the next heading, and the
 * Tools card would then act on the wrong section). Null when the body is empty.
 */
export function caretInSectionBody(doc: PMNode, sectionId: string): number | null {
  const range = sectionBodyRange(doc, sectionId);
  return range && range.to > range.from ? range.to - 1 : null;
}

/**
 * The top-level index of the heading whose section (as sectionBodyRange reads
 * it) holds the block at `index`, or -1 when no heading comes before it. A
 * sub-heading without a `specKey` (a "### Competitors" Claude wrote inside a
 * drafted section) belongs to the body of the heading above it, so the block
 * resolves to that outer section; a sub-heading with a `specKey` is a section
 * of its own and ends the walk.
 */
export function sectionHeadingIndexAt(doc: PMNode, index: number): number {
  let found = -1;
  // The shallowest heading passed so far: a heading at that level or deeper doesn't reach past it.
  let shallowest = Infinity;
  for (let i = Math.min(index, doc.childCount - 1); i >= 0; i--) {
    const node = doc.child(i);
    if (node.type.name !== "heading") continue;
    const level = Number(node.attrs.level ?? 2);
    if (level < shallowest) found = i;
    if (node.attrs.specKey) break;
    shallowest = Math.min(shallowest, level);
  }
  return found;
}
