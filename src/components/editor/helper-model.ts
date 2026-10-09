// When the empty-state helper shows (redesign2-spec.md §5.2), and where its
// per-document dismissal is kept. Pure apart from the storage helpers, which
// swallow a blocked localStorage (private windows, sandboxed previews).

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import type { TellMePhase } from "@/lib/tell-me/contract";

/**
 * True once the person has written a first paragraph: some top-level block
 * has text and another block follows it (they pressed Enter), or the only
 * text block has text and the selection has left it. Typing inside the first
 * paragraph alone keeps the helper.
 */
export function firstParagraphWritten(doc: PMNode, selection: Pick<Selection, "from" | "to"> | null): boolean {
  let textAt = -1;
  let textEnd = -1;
  let followed = false;
  doc.forEach((node, pos, index) => {
    if (textAt >= 0 || !node.textContent.trim()) return;
    textAt = pos;
    textEnd = pos + node.nodeSize;
    followed = index < doc.childCount - 1;
  });
  if (textAt < 0) return false;
  if (followed) return true;
  if (!selection) return false;
  return selection.to <= textAt || selection.from >= textEnd;
}

/**
 * Whether some top-level block has text. Read once, as the document opens: a
 * document that already has text never shows the helper (the selection rule in
 * firstParagraphWritten is for text written in this visit, and a loaded
 * document's caret starts inside its first paragraph).
 */
export function hasText(doc: PMNode): boolean {
  let found = false;
  doc.forEach((node) => {
    if (node.textContent.trim()) found = true;
  });
  return found;
}

/** Whether the document has any heading (an outline was laid out or written). */
export function hasHeadings(doc: PMNode): boolean {
  let found = false;
  doc.forEach((node) => {
    if (node.type.name === "heading") found = true;
  });
  return found;
}

export type HelperVisibleInput = {
  dismissed: boolean;
  typeKey: string | null;
  doc: PMNode;
  selection: Pick<Selection, "from" | "to"> | null;
  tellMePhase: TellMePhase;
};

/** The helper shows while "tell me" runs (progress and results), else on an untyped, unwritten document until dismissed. */
export function helperVisible({ dismissed, typeKey, doc, selection, tellMePhase }: HelperVisibleInput): boolean {
  if (tellMePhase !== "idle") return true;
  return !dismissed && !typeKey && !hasHeadings(doc) && !firstParagraphWritten(doc, selection);
}

/** The helper has nothing more to offer once the document is written or typed: dismiss it for good. */
export function shouldDismiss({ typeKey, doc, selection, tellMePhase }: Omit<HelperVisibleInput, "dismissed">): boolean {
  if (tellMePhase !== "idle") return false;
  return !!typeKey || hasHeadings(doc) || firstParagraphWritten(doc, selection);
}

export const HELPER_DISMISSED_PREFIX = "sasha.helper.dismissed.";

export const helperDismissedKey = (documentId: string) => `${HELPER_DISMISSED_PREFIX}${documentId}`;

/** localStorage, or null where it is blocked. */
function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readHelperDismissed(documentId: string, storage: Storage | null = safeStorage()): boolean {
  try {
    return storage?.getItem(helperDismissedKey(documentId)) === "1";
  } catch {
    return false;
  }
}

export function writeHelperDismissed(documentId: string, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(helperDismissedKey(documentId), "1");
  } catch {
    // Blocked storage: the helper is dismissed for this visit only.
  }
}
