"use client";

// The PanelHeader every side panel shares, and (re-exported) the Agents card.
// Agents, Section notes (section-notes-panel.tsx) and Check (check-panel.tsx)
// share one place in the editor's right column, above the Outline card
// (outline-panel.tsx); see right-column.tsx. The Sources panel is the body of
// the Sources dialog.

import { CircleX, X } from "@/components/icons";

export { ToolsPanel, type ToolsPanelProps } from "./tools-panel";

/**
 * "tools" (the Agents card; the key predates the rename) and "outline" are the
 * coloured cards' headers (redesign3-spec.md §14, §15): a 26px title that takes
 * focus when the card opens (headingId, tabIndex -1) and a circled X in the
 * card's ink. The card pads itself. "plain" is the small muted header of
 * Section notes, Check and Sources.
 */
export type PanelHeaderVariant = "tools" | "outline" | "plain";

const CARD_HEADER: Record<Exclude<PanelHeaderVariant, "plain">, { title: string; close: string; focus: string }> = {
  tools: {
    title: "text-[26px] font-semibold text-[var(--tools-ink)]",
    close: "text-[var(--tools-ink)] hover:bg-[var(--tools-chip)]",
    focus: "focus-visible:outline-[var(--tools-focus)]",
  },
  outline: {
    title: "text-[26px] font-semibold text-[var(--outline-ink)]",
    close: "text-[var(--outline-ink)] hover:bg-[var(--outline-hover)]",
    focus: "focus-visible:outline-[var(--outline-ink)]",
  },
};

export function PanelHeader({ title, onClose, variant = "plain", headingId }: { title: string; onClose: () => void; variant?: PanelHeaderVariant; headingId?: string }) {
  const label = `Close ${title.toLowerCase()}`;
  if (variant !== "plain") {
    const c = CARD_HEADER[variant];
    return (
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 id={headingId} tabIndex={headingId ? -1 : undefined} className={`rounded-md leading-tight outline-none focus-visible:outline-2 focus-visible:outline-offset-2 ${c.title} ${c.focus}`}>
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={label}
          className={`-mr-2 grid min-h-11 min-w-11 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 sm:min-h-9 sm:min-w-9 ${c.close} ${c.focus}`}
        >
          <CircleX className="h-7 w-7" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between px-5 pb-2 pt-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--doc-muted)]">{title}</h2>
      <button type="button" onClick={onClose} aria-label={label} className="grid min-h-11 min-w-11 place-items-center rounded-md text-[var(--doc-muted)] sm:min-h-8 sm:min-w-8 hover:bg-[var(--action-soft)] hover:text-[var(--action)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
