"use client";

// The PanelHeader every side panel shares, and (re-exported) the Tools card.
// Tools, Section notes (section-notes-panel.tsx) and Check (check-panel.tsx)
// share the upper slot of the editor's right column, above the Outline card
// (outline-panel.tsx); see right-column.tsx. The Sources panel is the body of
// the Sources dialog.

import { CircleX, X } from "@/components/icons";

export { ToolsPanel, type ToolsPanelProps } from "./tools-panel";

/**
 * "tools" and "outline" are the coloured cards' headers (redesign2-spec.md
 * §4.2, §4.4): a large title and a circled X in the card's ink. "plain" is the
 * small muted header of Section notes, Check and Sources.
 */
export type PanelHeaderVariant = "tools" | "outline" | "plain";

const CARD_HEADER: Record<Exclude<PanelHeaderVariant, "plain">, { title: string; close: string }> = {
  tools: {
    title: "text-[22px] font-semibold text-[var(--tools-ink)]",
    close: "text-[var(--tools-ink)] hover:bg-[var(--tools-chip)] focus-visible:outline-[var(--tools-focus)]",
  },
  outline: {
    title: "text-[22px] font-semibold text-[var(--outline-ink)]",
    close: "text-[var(--outline-ink)] hover:bg-[var(--outline-hover)] focus-visible:outline-[var(--outline-ink)]",
  },
};

export function PanelHeader({ title, onClose, variant = "plain" }: { title: string; onClose: () => void; variant?: PanelHeaderVariant }) {
  const label = `Close ${title.toLowerCase()}`;
  if (variant !== "plain") {
    const c = CARD_HEADER[variant];
    return (
      <div className="flex items-center justify-between px-5 pb-2 pt-4">
        <h2 className={c.title}>{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={label}
          className={`-mr-2 grid min-h-11 min-w-11 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 sm:min-h-8 sm:min-w-8 ${c.close}`}
        >
          <CircleX className="h-6 w-6" />
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
