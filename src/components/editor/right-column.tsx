"use client";

// The editor's right column: the Tools card (or Section notes / Check, which
// take its slot) above the Outline card, stacked as floating cards, each
// scrolling on its own. Where it sits depends on the room
// (right-column-model.ts rightColumnMode): beside the text and sticky under
// the toolbar when the editor area is wide, a drawer over the text on the
// right (below the header and toolbar) when it isn't, and a bottom sheet on
// phones. The drawer and sheet are non-modal; Esc inside them closes them.
// The column itself is transparent (redesign2-spec.md §4.5): the cards carry
// their own colours (olive Tools, cream Outline, plain notes and Check). A
// slot is focusable so a floating button that hides can hand focus into its
// card; the next Tab reaches the card's close button.

import type { ReactNode } from "react";
import { OUTLINE_SLOT_ID, RIGHT_COLUMN_MODE_CLASS as MODE_CLASS, slotClass, TOOLS_SLOT_ID, type RightColumnMode } from "./right-column-model";

export const RIGHT_COLUMN_ID = "editor-right-column";

export function RightColumn({
  mode,
  tools,
  outline,
  onDismiss,
  sheetLeft = 0,
}: {
  mode: RightColumnMode;
  /** Tools, Section notes or Check (the upper card), or null. */
  tools: ReactNode | null;
  /** The outline (the lower card), or null. */
  outline: ReactNode | null;
  /** Closes everything in the column (Esc in the drawer or sheet). */
  onDismiss: () => void;
  /** The sheet's left edge (the editor area's left, so it doesn't run under the app rail). */
  sheetLeft?: number;
}) {
  if (!tools && !outline) return null;
  const both = !!tools && !!outline;
  return (
    <div
      id={RIGHT_COLUMN_ID}
      style={mode === "sheet" ? { left: sheetLeft } : undefined}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || mode === "inline") return;
        const target = e.target as HTMLElement;
        // Keys from portalled menus/dialogs bubble here through React; leave those to them.
        if (!e.currentTarget.contains(target) || target.closest('[role="menu"],[role="dialog"],[data-radix-popper-content-wrapper]')) return;
        e.preventDefault();
        onDismiss();
      }}
      className={`text-[var(--doc-ink)] ${MODE_CLASS[mode]}`}
    >
      {tools && (
        <div id={TOOLS_SLOT_ID} tabIndex={-1} className={slotClass(mode, "lower", both)}>
          {tools}
        </div>
      )}
      {outline && (
        <div id={OUTLINE_SLOT_ID} tabIndex={-1} className={slotClass(mode, "outline", both)}>
          {outline}
        </div>
      )}
    </div>
  );
}
