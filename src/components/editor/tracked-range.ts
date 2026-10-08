// Follows a selected range through the edits made while a slow operation (a
// rewrite can take a couple of minutes) runs, so its result lands where the
// text now is, or not at all if that text was changed or removed.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Mapping } from "@tiptap/pm/transform";

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
