"use client";

// The classifier's quiet chip in the document header (PLAN §6.3): "Looks like
// a <Type>: apply outline?" with Apply, Not now, and the alternatives.
// Inline in the header's wrapping row; the top candidate's reason is its
// tooltip. The live region is always mounted so the chip's arrival is
// announced politely.

import { ChevronDown } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ChipSuggestion } from "@/lib/classifier/contract";

/** "a" or "an" before a type title. */
export function article(title: string): string {
  return /^[aeiou]/i.test(title.trim()) ? "an" : "a";
}

const button =
  "inline-flex min-h-11 items-center rounded-full px-2.5 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] sm:min-h-0 sm:py-0.5";

export function ClassifierChip({
  suggestion,
  onApply,
  onDismiss,
}: {
  suggestion: ChipSuggestion | null;
  /** Apply the type (the top candidate or an alternative) in merge mode. */
  onApply: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const announcement = suggestion ? `Looks like ${article(suggestion.title)} ${suggestion.title}. Apply its outline?` : "";
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {suggestion && (
        <div
          role="group"
          aria-label="Document type suggestion"
          title={suggestion.why || undefined}
          className="flex max-w-full flex-wrap items-center gap-x-0.5 gap-y-1 rounded-2xl bg-[var(--go-soft)] py-0.5 pl-3 pr-1 text-sm text-[var(--go)] sm:rounded-full"
        >
          <span className="mr-1">
            Looks like {article(suggestion.title)} <strong className="font-semibold">{suggestion.title}</strong>: apply outline?
          </span>
          <button type="button" onClick={() => onApply(suggestion.key)} className={`${button} hover:bg-[var(--go-soft-strong)]`}>
            Apply
          </button>
          <button type="button" onClick={() => onDismiss(suggestion.key)} className={`${button} hover:bg-[var(--go-soft-strong)]`}>
            Not now
          </button>
          {suggestion.alternatives.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Other suggestions"
                  title="Other suggestions"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-[var(--go-soft-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] sm:min-h-7 sm:min-w-7"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-32px)]">
                <DropdownMenuLabel>Other suggestions</DropdownMenuLabel>
                {suggestion.alternatives.map((alt) => (
                  <DropdownMenuItem key={alt.key} onSelect={() => onApply(alt.key)} className="flex min-h-11 flex-col items-start gap-0.5 sm:min-h-0">
                    <span className="font-medium">{alt.title}</span>
                    {alt.why && <span className="text-xs text-[var(--doc-muted)]">{alt.why}</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </>
  );
}
