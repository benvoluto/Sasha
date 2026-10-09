// Matching a marker's quote against its passage (phase7-spec.md §2.2). Shared
// by the server check (verify.ts, references.ts) and the popover highlight
// (citation-layer-model.ts), so both agree on what counts as "in the passage".
// Pure.

import { canon } from "@/lib/sources/passages";

/** Shorter than this (canon characters), a quote counts as absent rather than a mismatch. */
export const MIN_QUOTE = 3;

const TRAILING_ELLIPSIS = /\s*(…|\.\.\.)\s*$/;

/** A quote as compared: its canon text, and whether it ended in an ellipsis (its last word may then be cut short). */
export type QuoteKey = { text: string; open: boolean };

/** The quote as compared, or null when too short to check. */
export function quoteKey(quote: string | null | undefined): QuoteKey | null {
  if (!quote) return null;
  const open = TRAILING_ELLIPSIS.test(quote);
  const text = canon(quote.replace(TRAILING_ELLIPSIS, ""));
  return text.length < MIN_QUOTE ? null : { text, open };
}

/**
 * Where `key` starts in `flat` (canon text, single spaces), matching whole
 * words only, so "rose 1" is not found in "rose 12" nor "ales" in "sales";
 * the last word may be a prefix only when the quote ended in an ellipsis.
 * -1 when absent.
 */
export function findQuote(flat: string, key: QuoteKey): number {
  for (let at = flat.indexOf(key.text); at >= 0; at = flat.indexOf(key.text, at + 1)) {
    const end = at + key.text.length;
    if ((at === 0 || flat[at - 1] === " ") && (key.open || end === flat.length || flat[end] === " ")) return at;
  }
  return -1;
}

/** Is `quote` (tolerantly, by whole words) in `passage`? True when the quote is too short to check. */
export function quoteMatches(quote: string, passage: string): boolean {
  const key = quoteKey(quote);
  return key === null || findQuote(canon(passage), key) >= 0;
}
