// Applying a type's outline to a document that already has text, in merge mode
// (PLAN §6.3, §6.7): the type's sections are added around the existing content
// and no prose is rewritten. Used by the type picker, the gallery and the
// classifier chip (document-screen.tsx chooseType).
//
// The plan comes from planOutlineMerge (src/catalog/outline-merge.ts): existing
// headings that match a section by text are tagged with its specKey, and each
// missing section is inserted after the section before it in outline order.
// Everything goes into one transaction, so a single Undo reverts it.

import type { Editor } from "@tiptap/react";
import { Fragment, type Node as PMNodeType } from "@tiptap/pm/model";
import { sectionNodes } from "@/catalog/outline";
import { planOutlineMerge } from "@/catalog/outline-merge";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { PMNode } from "@/lib/documents/sections";

export type OutlineMergeResult = {
  /** Sections inserted. */
  added: number;
  /** Existing headings given the matching section's specKey. */
  tagged: number;
  /** Whether the sections were placed in outline order (false: appended at the end). */
  inOrder: boolean;
};

/** Merge `type`'s outline into the editor's document as one undoable step. */
export function applyOutlineMerge(editor: Editor, type: DocumentTypeSummary, newId: () => string): OutlineMergeResult {
  const { state } = editor;
  const plan = planOutlineMerge(state.doc.toJSON() as PMNode, type.sections);
  const added = plan.insert.reduce((n, i) => n + i.sections.length, 0);
  if (!plan.tag.length && !added) return { added: 0, tagged: 0, inOrder: false };

  // Start position of each top-level node, and the end of the document.
  const starts: number[] = [];
  let pos = 0;
  state.doc.forEach((node) => {
    starts.push(pos);
    pos += node.nodeSize;
  });
  const after = (index: number) => (index < 0 ? 0 : index + 1 < starts.length ? starts[index + 1] : state.doc.content.size);

  const tr = state.tr;
  // Re-tagging keeps every position: setNodeMarkup changes attributes only.
  for (const t of plan.tag) {
    const node = state.doc.child(t.index);
    tr.setNodeMarkup(starts[t.index], undefined, { ...node.attrs, specKey: t.specKey });
  }
  // Inserts from the last position backwards, so earlier positions stay valid.
  for (const ins of [...plan.insert].reverse()) {
    const nodes: PMNodeType[] = ins.sections.flatMap((s) => sectionNodes(s, newId)).map((json) => state.schema.nodeFromJSON(json));
    tr.insert(after(ins.afterIndex), Fragment.fromArray(nodes));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return { added, tagged: plan.tag.length, inOrder: plan.inOrder };
}
