"use client";

// The editor's right column: the outline on top and Tools or Section notes
// below, stacked, each scrolling on its own (one alone takes the full height).
// Where it sits depends on the room (right-column-model.ts rightColumnMode):
// beside the text and sticky under the toolbar when the editor area is wide,
// a drawer over the text on the right (below the header and toolbar) when it isn't, and a bottom sheet above
// the floating buttons on phones. The drawer and sheet are non-modal; Esc
// inside them closes them.

import type { ReactNode } from "react";
import { RIGHT_COLUMN_MODE_CLASS as MODE_CLASS, type RightColumnMode } from "./right-column-model";

export const RIGHT_COLUMN_ID = "editor-right-column";

export function RightColumn({
  mode,
  top,
  bottom,
  onDismiss,
  sheetLeft = 0,
}: {
  mode: RightColumnMode;
  /** The outline, or null. */
  top: ReactNode | null;
  /** Tools or Section notes, or null. */
  bottom: ReactNode | null;
  /** Closes everything in the column (Esc in the drawer or sheet). */
  onDismiss: () => void;
  /** The sheet's left edge (the editor area's left, so it doesn't run under the app rail). */
  sheetLeft?: number;
}) {
  if (!top && !bottom) return null;
  // Each slot is a flex column whose panel (an <aside> with its own scroll area) fills it.
  const slot = "flex min-h-0 flex-1 flex-col [&>*]:min-h-0 [&>*]:flex-1";
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
      className={`flex flex-col bg-[var(--editor-bg)] text-[var(--doc-ink)] ${MODE_CLASS[mode]}`}
    >
      {top && <div className={slot}>{top}</div>}
      {bottom && <div className={`${slot} ${top ? "border-t border-[var(--doc-line)]" : ""}`}>{bottom}</div>}
    </div>
  );
}
