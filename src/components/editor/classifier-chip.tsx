"use client";

// The classifier's suggestion (PLAN §6.3), shown in the Document Gallery's
// top block (redesign2-spec.md §3.2): "Looks like a <Type>." with the reason,
// Apply, Not now, and the alternatives. The header's Document Gallery button
// shows a dot while a suggestion waits, and document-screen keeps the polite
// live region that announces it (suggestionAnnouncement).
//
// "Restructure…" (phase6-spec.md §8.3), beside Apply and on each alternative,
// maps the existing text onto the type's outline with the restructure
// workflow. On a document that already has a type, Apply itself reads
// "Restructure?" and opens that flow (applyLabel; chipApplyAction).

import type { ChipSuggestion } from "@/lib/classifier/contract";

/** "a" or "an" before a type title. */
export function article(title: string): string {
  return /^[aeiou]/i.test(title.trim()) ? "an" : "a";
}

/** What the screen's live region says when a suggestion arrives. */
export function suggestionAnnouncement(suggestion: ChipSuggestion | null): string {
  if (!suggestion) return "";
  return `Sasha suggests ${article(suggestion.title)} ${suggestion.title} outline. Open the Document Gallery to apply it.`;
}

const button =
  "inline-flex min-h-11 items-center rounded-lg border border-[var(--go-line)] px-3 text-sm font-medium text-[var(--go)] hover:bg-[var(--go-soft-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] sm:min-h-8";

export function ClassifierSuggestion({
  suggestion,
  onApply,
  onRestructure,
  onDismiss,
  applyLabel = "Apply",
}: {
  suggestion: ChipSuggestion;
  /** Apply the type (the top candidate or an alternative): in merge mode, or the restructure flow on a typed document. */
  onApply: (key: string) => void;
  /** "Restructure…": open the restructure workflow with this type as the target. */
  onRestructure?: (key: string) => void;
  onDismiss: (key: string) => void;
  /** "Apply outline", or "Restructure?" when the document already has a type. */
  applyLabel?: string;
}) {
  // Restructure is offered separately only where Apply merges (an untyped document).
  const offerRestructure = !!onRestructure && applyLabel !== "Restructure?";
  return (
    <section aria-label="Suggested type" className="space-y-2 rounded-xl bg-[var(--go-soft)] px-3.5 py-3 text-sm text-[var(--doc-ink)]">
      <p>
        Looks like {article(suggestion.title)} <strong className="font-semibold">{suggestion.title}</strong>.
        {suggestion.why && <span className="text-[var(--doc-muted)]"> {suggestion.why}</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onApply(suggestion.key)} className={button}>
          {applyLabel}
        </button>
        {offerRestructure && (
          <button type="button" onClick={() => onRestructure?.(suggestion.key)} title="Map the existing text onto this type's outline" className={button}>
            Restructure…
          </button>
        )}
        <button type="button" onClick={() => onDismiss(suggestion.key)} className={button}>
          Not now
        </button>
      </div>
      {suggestion.alternatives.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-[var(--doc-muted)]">Other possibilities</p>
          <ul className="flex flex-wrap gap-2">
            {suggestion.alternatives.map((alt) => (
              <li key={alt.key} className="flex flex-wrap gap-1">
                <button type="button" onClick={() => onApply(alt.key)} title={alt.why || undefined} className={button}>
                  {alt.title}
                  {!offerRestructure && <span className="sr-only">, {applyLabel}</span>}
                </button>
                {offerRestructure && (
                  <button type="button" onClick={() => onRestructure?.(alt.key)} aria-label={`Restructure to ${alt.title}`} title={`Restructure to ${alt.title}`} className={button}>
                    Restructure…
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
