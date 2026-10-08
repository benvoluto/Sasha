"use client";

// "Add table" in the Data tab (phase5-spec.md §5.2): the tables read from this
// document's sources, then the team's library searched as you type. Tables
// already on the document say "Linked" (and can still be chosen for a
// suggestion's prefill, which only marks it). Choosing one links it (the pane
// does the request) and closes the picker.

import { useEffect, useState } from "react";
import { Check, Loader2, Search } from "@/components/icons";
import { api, errorText, styles } from "@/components/sources/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DataTableSummary, TableListResponse } from "@/lib/data/contract";
import { matchesQuery, methodLabel, pickerGroups, SEARCH_DEBOUNCE_MS, shapeText, tableMeta, type PickerRow } from "./data-pane-model";

export function DataTablePicker({
  open,
  onOpenChange,
  documentId,
  linkedIds,
  initialQuery = "",
  pickLinked = false,
  onPick,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The saved document, for its sources' tables; null shows only the library. */
  documentId: string | null;
  /** Tables already linked to the document. */
  linkedIds: string[];
  /** The search the picker opens with (a suggestion's label). */
  initialQuery?: string;
  /** Linked tables can be chosen too (adding for a suggestion: linking is idempotent and marks it). */
  pickLinked?: boolean;
  /** Links the table; resolves to an error message, or null when it was linked. */
  onPick: (table: DataTableSummary) => Promise<string | null>;
  /**
   * Where focus goes when the picker closes. It has no DialogTrigger to return
   * to, so without this focus would fall to <body> outside the document modal.
   */
  returnFocus?: () => HTMLElement | null;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [forDocument, setForDocument] = useState<DataTableSummary[] | null>(null);
  const [library, setLibrary] = useState<DataTableSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      return;
    }
    setError(null);
    setBusy(null);
  }, [open, initialQuery]);

  // The document's sources' tables, once per opening.
  useEffect(() => {
    if (!open) return;
    if (!documentId) {
      setForDocument([]);
      return;
    }
    let cancelled = false;
    setForDocument(null);
    api<TableListResponse>(`/api/data/tables?for_document=${encodeURIComponent(documentId)}`)
      .then(({ tables }) => !cancelled && setForDocument(tables))
      .catch((e) => {
        if (cancelled) return;
        setForDocument([]);
        setError(errorText(e, "Couldn't load the tables."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, documentId]);

  // The library, searched after a pause in typing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = query.trim();
    const t = window.setTimeout(
      async () => {
        try {
          const { tables } = await api<TableListResponse>(`/api/data/tables${q ? `?q=${encodeURIComponent(q)}` : ""}`);
          if (!cancelled) setLibrary(tables);
        } catch (e) {
          if (!cancelled) setError(errorText(e, "Couldn't search the library."));
        }
      },
      q ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, query]);

  const groups = pickerGroups((forDocument ?? []).filter((t) => matchesQuery(t, query)), library ?? [], linkedIds);

  const pick = async (row: PickerRow) => {
    if ((row.linked && !pickLinked) || busy) return;
    setBusy(row.table.id);
    setError(null);
    const err = await onPick(row.table);
    setBusy(null);
    if (err) setError(err);
    else onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          const el = returnFocus?.();
          if (!el?.isConnected) return;
          e.preventDefault();
          el.focus();
        }}
        className="flex max-h-[85dvh] w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl border-[var(--doc-line)] bg-[var(--doc-surface)] font-sans text-[var(--doc-ink)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a table</DialogTitle>
          <DialogDescription className="text-[var(--doc-muted)]">Choose a table read from your sources.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--doc-muted)]" aria-hidden />
          <label htmlFor="data-picker-search" className="sr-only">
            Search tables
          </label>
          <input
            id="data-picker-search"
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tables, columns and sources"
            className={`${styles.field} min-h-11 pl-8 sm:min-h-9`}
          />
        </div>
        <div className="-mx-2 min-h-40 flex-1 space-y-4 overflow-y-auto">
          <Group
            title="From this document's sources"
            rows={documentId ? groups.fromDocument : null}
            loading={!!documentId && forDocument === null}
            busy={busy}
            pickLinked={pickLinked}
            onPick={pick}
            empty={query.trim() ? "No tables here match." : "No tables in this document's sources yet."}
          />
          <Group
            title="Library"
            rows={groups.library}
            loading={library === null}
            busy={busy}
            pickLinked={pickLinked}
            onPick={pick}
            empty={query.trim() ? "No other tables match." : "No other tables in the library."}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Group({
  title,
  rows,
  loading,
  busy,
  pickLinked,
  onPick,
  empty,
}: {
  title: string;
  /** null hides the group (an unsaved document has no sources). */
  rows: PickerRow[] | null;
  loading: boolean;
  busy: string | null;
  pickLinked: boolean;
  onPick: (row: PickerRow) => void;
  empty: string;
}) {
  if (rows === null) return null;
  const id = `data-picker-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="px-2">
      <h3 id={id} className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">
        {title}
      </h3>
      {loading ? (
        <p className="flex items-center gap-2 py-3 text-sm text-[var(--doc-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="py-3 text-sm text-[var(--doc-muted)]">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => {
            const locked = r.linked && !pickLinked;
            return (
              <li key={r.table.id}>
                <button
                  type="button"
                  onClick={() => onPick(r)}
                  disabled={locked || (busy !== null && busy !== r.table.id)}
                  className={`flex min-h-11 w-full items-start gap-3 rounded-lg px-2 py-2 text-left ${locked ? "opacity-60" : "hover:bg-[var(--go-soft)] disabled:opacity-50"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.table.name}</span>
                    <span className="block truncate text-xs text-[var(--doc-muted)]">
                      {[tableMeta(r.table), methodLabel(r.table.extraction_method), shapeText(r.table)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {busy === r.table.id ? (
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--go)]" aria-label="Adding" />
                  ) : r.linked ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--go-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--go)]">
                      <Check className="h-3 w-3" aria-hidden /> Linked
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
