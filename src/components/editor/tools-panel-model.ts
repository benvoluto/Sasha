// The Tools card's rules, kept pure so they are tested on their own
// (redesign2-spec.md §4.2–4.3): what "Rewrite as…" acts on, the line that says
// so, and whether the Draft row can run.

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { SectionSummary } from "@/catalog/schema";
import { sectionBodyRange } from "./tracked-range";

/**
 * What a rewrite acts on. "selection" and "block" are a document range that
 * goes through the selection path (snapshot, /rewrite, one replacing
 * transaction); "section" goes through useSectionGeneration's run.
 */
export type RewriteTarget =
  | { kind: "selection"; from: number; to: number; text: string }
  | { kind: "section"; sectionId: string; heading: string }
  | { kind: "block"; from: number; to: number; text: string }
  | { kind: "none" };

/**
 * The selection when it holds text; else the caret's section when its body has
 * text; else the caret's top-level block when it has text and isn't a heading
 * (a rewritten heading would be a surprise); else nothing. A text block's
 * range is its inside, so a one-paragraph result replaces the words and keeps
 * the paragraph; any other block (a list, a quote) is replaced whole.
 */
export function rewriteTarget(state: Pick<EditorState, "doc" | "selection">, caretSectionId: string | null): RewriteTarget {
  const { doc, selection } = state;
  if (!selection.empty) {
    const text = doc.textBetween(selection.from, selection.to, "\n\n").trim();
    if (text) return { kind: "selection", from: selection.from, to: selection.to, text };
  }
  if (caretSectionId) {
    const section = sectionBodyRange(doc, caretSectionId);
    if (section?.bodyText.trim()) return { kind: "section", sectionId: caretSectionId, heading: section.heading };
  }
  if (doc.childCount === 0) return { kind: "none" };
  const index = Math.min(selection.$head.index(0), doc.childCount - 1);
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  const block: PMNode = doc.child(index);
  if (block.type.name === "heading") return { kind: "none" };
  const from = block.isTextblock ? pos + 1 : pos;
  const to = block.isTextblock ? pos + block.nodeSize - 1 : pos + block.nodeSize;
  const text = doc.textBetween(from, to, "\n\n").trim();
  return text ? { kind: "block", from, to, text } : { kind: "none" };
}

/**
 * Where and what a rewrite's result replaces. One paragraph back for a range
 * inside one text block: its text, so the block keeps its type. A range across
 * top-level text blocks from the start of one to the end of another (a
 * selection that takes in a heading and its paragraph): the whole blocks, so
 * the first block (the heading) doesn't swallow the rewritten text; but when
 * the result starts with the heading's own words (the text sent has no
 * markdown, so the model gives the heading back as a line), those words stay
 * in the heading and the rest follows it. Anything else: the result into the
 * range as it is.
 */
export function rewriteInsertion<B extends { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }>(
  doc: PMNode,
  range: { from: number; to: number },
  blocks: B[],
): { from: number; to: number; content: unknown[] } {
  const single = blocks.length === 1 && blocks[0].type === "paragraph";
  const $from = doc.resolve(range.from);
  const $to = doc.resolve(range.to);
  const whole =
    !$from.sameParent($to) &&
    $from.depth === 1 &&
    $to.depth === 1 &&
    $from.parent.isTextblock &&
    $to.parent.isTextblock &&
    $from.parentOffset === 0 &&
    $to.parentOffset === $to.parent.content.size;
  if (whole) {
    const heading = $from.parent.type.name === "heading" ? $from.parent : null;
    // The heading's words back as the first line: they stay a heading, with its attributes (its sectionId).
    if (heading && blocks.length > 1 && inlineText(blocks[0].content).trim() === heading.textContent.trim()) {
      return { from: $from.before(1), to: $to.after(1), content: [{ ...blocks[0], type: "heading", attrs: { ...heading.attrs } }, ...blocks.slice(1)] };
    }
    return { from: $from.before(1), to: $to.after(1), content: blocks };
  }
  return { from: range.from, to: range.to, content: single ? (blocks[0].content ?? []) : blocks };
}

/** The text of a block's JSON content. */
function inlineText(content: unknown[] | undefined): string {
  return (content ?? []).map((c) => {
    const n = c as { text?: string; content?: unknown[] };
    return n.text ?? inlineText(n.content);
  }).join("");
}

/** The line under "Rewrite as…"; for "none" it is also why the chips are disabled. */
export function rewriteTargetLine(target: RewriteTarget): string {
  if (target.kind === "selection") return "Rewrites your selection.";
  if (target.kind === "section") return `Rewrites “${target.heading.trim() || "Untitled section"}”.`;
  if (target.kind === "block") return "Rewrites this paragraph.";
  return "Select text or put the cursor in a section.";
}

/** The Draft row: its label and, when it can't run, the reason it shows. Mirrors section-menu.tsx. */
export type DraftRow = { label: "Draft this section" | "Draft again"; sectionId: string | null; disabledReason: string | null };

export function draftRow(doc: PMNode, sections: SectionSummary[] | null | undefined, caretSectionId: string | null, busy: ReadonlySet<string>): DraftRow {
  const section = caretSectionId ? sectionBodyRange(doc, caretSectionId) : null;
  const label = section?.bodyText.trim() ? "Draft again" : "Draft this section";
  if (!caretSectionId || !section) return { label, sectionId: null, disabledReason: "Put the cursor in a section" };
  if (busy.has(caretSectionId)) return { label, sectionId: caretSectionId, disabledReason: "Claude is writing…" };
  const spec = section.specKey ? sections?.find((s) => s.key === section.specKey) : undefined;
  if (spec?.renderer === "static") return { label, sectionId: caretSectionId, disabledReason: "Fixed text" };
  if (!section.heading.trim()) return { label, sectionId: caretSectionId, disabledReason: "Add a heading first" };
  return { label, sectionId: caretSectionId, disabledReason: null };
}

/** Words in the document, for the card's footer. */
export function wordCount(doc: PMNode): number {
  return doc.textBetween(0, doc.content.size, " ", " ").trim().match(/\S+/g)?.length ?? 0;
}
