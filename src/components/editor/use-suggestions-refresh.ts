"use client";

// Regenerates the document's suggestions in the background when its type,
// notes or linked sources change (debounced 15 s, so the autosave has landed
// and a burst of typing is one request; the server gates and short-circuits
// unchanged inputs), so the Suggestions tab is current when opened. Nothing
// runs for the values the document opened with, and failures are ignored: the
// tab regenerates on open anyway. A 429 (the light allowance) is quiet too: the
// change stays pending and is sent again once Retry-After has passed.

import { useEffect, useRef } from "react";
import { retryAfterMs } from "@/lib/limits/client";

export const SUGGESTIONS_REFRESH_DEBOUNCE_MS = 15_000;

/**
 * A stable key for the linked sources as the generator sees them (the ids and
 * their summaries; generate.ts hashes the same), so a source linked, removed or
 * newly summarized counts as a change and a re-render doesn't.
 */
export function linkedSourcesKey(sources: ReadonlyArray<{ id: string; summary: string | null }>): string {
  return JSON.stringify(
    [...sources]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((s) => [s.id, s.summary ?? ""]),
  );
}

type Seen = { documentId: string | null; key: string; sources: string | null; dirty: boolean };

export function useSuggestionsRefresh(input: {
  documentId: string | null;
  typeKey: string | null;
  notes: string;
  /** linkedSourcesKey of the linked sources, or null while they haven't been loaded (the Sources tab reports them). */
  sources?: string | null;
}): void {
  const { documentId, typeKey, notes, sources = null } = input;
  // The inputs last seen per document; the first values for a document only set
  // the baseline, and the first known sources likewise. `dirty` is a change not
  // yet sent, so a re-render that cancels the timer reschedules it.
  const seen = useRef<Seen | null>(null);

  useEffect(() => {
    const key = JSON.stringify([typeKey, notes]);
    const prev = seen.current;
    // A document that just got its id (first save) is the same document; a
    // switch to another document starts over.
    const sameDoc = !!prev && (prev.documentId === null || prev.documentId === documentId);
    const baseSources = sameDoc ? prev.sources : null;
    const sourcesMoved = sources !== null && baseSources !== null && sources !== baseSources;
    const changed = sameDoc && (prev.key !== key || sourcesMoved);
    const dirty = !!documentId && sameDoc && (changed || prev.dirty);
    const next: Seen = { documentId, key, sources: sources ?? baseSources, dirty };
    seen.current = next;
    if (!dirty || !documentId) return;
    let cancelled = false;
    const send = async () => {
      next.dirty = false;
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/suggestions/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          keepalive: true,
        });
        const wait = res.status === 429 ? retryAfterMs(429, await res.json().catch(() => null), res.headers.get("Retry-After")) : null;
        if (wait === null || cancelled) return;
        // Still pending: a re-render that cancels this retry schedules the change again.
        next.dirty = true;
        t = window.setTimeout(() => void send(), Math.max(SUGGESTIONS_REFRESH_DEBOUNCE_MS, wait));
      } catch {
        // Background work: the tab regenerates on open anyway.
      }
    };
    let t = window.setTimeout(() => void send(), SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [documentId, typeKey, notes, sources]);
}
