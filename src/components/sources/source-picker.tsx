"use client";

// "Pick from library": search the team's sources and link the chosen ones to a
// document.

import { useEffect, useState } from "react";
import { Check, Loader2, Search } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorText, KindIcon, sourceTitle, StatusChip, styles, when, type SourceSummary } from "./shared";

export function SourcePicker({
  open,
  onOpenChange,
  documentId,
  linkedIds,
  onLinked,
  initialQuery = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves the document to link to (saving a new document first). */
  documentId: () => Promise<string | null>;
  /** Sources already on the document, shown as linked. */
  linkedIds: string[];
  /** After linking, with the ids of the sources just linked. */
  onLinked: (sourceIds: string[]) => void;
  /** The search the picker opens with (a suggestion's label). */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SourceSummary[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      return;
    }
    setQuery("");
    setChosen(new Set());
    setError(null);
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = window.setTimeout(
      async () => {
        try {
          const { sources } = await api<{ sources: SourceSummary[] }>(`/api/sources?limit=100&q=${encodeURIComponent(query.trim())}`);
          if (!cancelled) setResults(sources);
        } catch (e) {
          if (!cancelled) setError(errorText(e, "Couldn't load the library."));
        }
      },
      query ? 200 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, query]);

  const linked = new Set(linkedIds);
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await documentId();
      if (!id) throw new Error("Save the document before adding sources.");
      for (const sourceId of chosen) {
        await api(`/api/documents/${encodeURIComponent(id)}/sources`, { method: "POST", json: { source_id: sourceId } });
      }
      onLinked([...chosen]);
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, "Couldn't link the sources."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 rounded-2xl border-[var(--doc-line)] bg-[var(--doc-surface)] text-[var(--doc-ink)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add from library</DialogTitle>
          <DialogDescription className="text-[var(--doc-muted)]">Choose sources your team has already added.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--doc-muted)]" aria-hidden />
          <label htmlFor="source-picker-search" className="sr-only">
            Search sources
          </label>
          <input
            id="source-picker-search"
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, files and text"
            className={`${styles.field} pl-8`}
          />
        </div>
        <div className="-mx-2 min-h-40 flex-1 overflow-y-auto">
          {results === null ? (
            <p className="flex items-center gap-2 px-2 py-6 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : results.length === 0 ? (
            <p className="px-2 py-6 text-sm text-[var(--doc-muted)]">{query ? "No sources match." : "The library is empty. Upload a file or add a link first."}</p>
          ) : (
            <ul className="space-y-0.5" aria-label="Sources">
              {results.map((s) => {
                const already = linked.has(s.id);
                const on = already || chosen.has(s.id);
                return (
                  <li key={s.id}>
                    <label
                      className={`flex items-start gap-3 rounded-lg px-2 py-2 ${already ? "opacity-60" : "cursor-pointer hover:bg-[var(--doc-accent-soft)]"}`}
                    >
                      <input type="checkbox" checked={on} disabled={already} onChange={() => toggle(s.id)} className="peer sr-only" />
                      <span
                        aria-hidden
                        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--doc-accent)] ${
                          on ? "border-[var(--doc-accent)] bg-[var(--doc-accent)] text-[var(--doc-on-accent)]" : "border-[var(--doc-line)]"
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <KindIcon kind={s.kind} className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{sourceTitle(s)}</span>
                        <span className="block truncate text-xs text-[var(--doc-muted)]">{already ? "Already on this document" : s.summary || when(s.created_at)}</span>
                      </span>
                      <StatusChip status={s.extraction_status} error={s.extraction_error} />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <DialogFooter>
          <button type="button" onClick={() => onOpenChange(false)} className={styles.quiet}>
            Cancel
          </button>
          <button type="button" onClick={link} disabled={busy || chosen.size === 0} className={styles.primary}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {chosen.size ? `Add ${chosen.size} source${chosen.size === 1 ? "" : "s"}` : "Add sources"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
