"use client";

// The library drawer's Tables section (phase5-spec.md §5.4): the tables read
// from a source, each with where it sits in the file, its size, a collapsed
// five-row preview, Hide/Unhide and Download CSV. Earlier versions (tables a
// re-read or a person superseded) wait behind "Show earlier versions".
// ?table=<id>, the target of a snapshot's citation link, scrolls to that table
// and expands it.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Eye, EyeOff, Loader2 } from "@/components/icons";
import { DataTablePreview } from "@/components/editor/data-table-preview";
import { LIBRARY_PREVIEW_ROWS, methodLabel, shapeText, statusChips } from "@/components/editor/data-pane-model";
import { tableLocation, type DataRow, type DataTableSummary, type TableListResponse, type TablePatchResponse, type TableResponse } from "@/lib/data/contract";
import { api, errorText } from "./shared";

const listUrl = (sourceId: string, status: string) => `/api/data/tables?source_id=${encodeURIComponent(sourceId)}&status=${status}`;

export function SourceTables({
  sourceId,
  canHave,
  busy,
  status,
  focusTableId,
}: {
  sourceId: string;
  /** The source's kind and type can have tables; otherwise the section hides when there are none. */
  canHave: boolean;
  /** The source is still being read. */
  busy: boolean;
  /** The source's extraction status; the tables reload when it changes. */
  status: string;
  /** ?table=: scroll to this table and expand it. */
  focusTableId: string | null;
}) {
  const [tables, setTables] = useState<DataTableSummary[] | null>(null);
  const [earlier, setEarlier] = useState<DataTableSummary[]>([]);
  const [showEarlier, setShowEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [current, old] = await Promise.all([
        api<TableListResponse>(listUrl(sourceId, "active,hidden")),
        api<TableListResponse>(listUrl(sourceId, "superseded")).catch((): TableListResponse => ({ tables: [] })),
      ]);
      setTables(current.tables);
      setEarlier(old.tables);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Couldn't load the tables."));
      setTables((t) => t ?? []);
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
  }, [load, status]);

  // A citation link to an earlier version opens the earlier versions.
  useEffect(() => {
    if (focusTableId && earlier.some((t) => t.id === focusTableId)) setShowEarlier(true);
  }, [focusTableId, earlier]);

  const replace = (t: DataTableSummary) => {
    setTables((list) => list?.map((x) => (x.id === t.id ? t : x)) ?? list);
    setEarlier((list) => list.map((x) => (x.id === t.id ? t : x)));
  };

  const none = tables !== null && tables.length === 0 && earlier.length === 0;
  if (none && !busy && !canHave && !error) return null;

  return (
    <section aria-labelledby="source-tables-heading" className="space-y-2">
      <h4 id="source-tables-heading" className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">
        Tables{tables && tables.length > 0 ? ` (${tables.length})` : ""}
      </h4>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {busy ? (
        <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading tables…
        </p>
      ) : tables === null ? (
        <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : tables.length === 0 ? (
        <p className="text-sm text-[var(--doc-muted)]">No tables found.</p>
      ) : null}
      {tables && tables.length > 0 && (
        <ul className="space-y-2">
          {tables.map((t) => (
            <li key={t.id}>
              <TableItem table={t} focus={t.id === focusTableId} onChanged={replace} />
            </li>
          ))}
        </ul>
      )}
      {earlier.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showEarlier}
            onClick={() => setShowEarlier((v) => !v)}
            className="flex min-h-11 items-center gap-1 text-xs font-medium text-[var(--doc-muted)] hover:text-[var(--doc-ink)] sm:min-h-8"
          >
            {showEarlier ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
            {showEarlier ? "Hide earlier versions" : `Show earlier versions (${earlier.length})`}
          </button>
          {showEarlier && (
            <ul className="mt-1 space-y-2">
              {earlier.map((t) => (
                <li key={t.id}>
                  <TableItem table={t} focus={t.id === focusTableId} onChanged={replace} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function TableItem({ table, focus, onChanged }: { table: DataTableSummary; focus: boolean; onChanged: (t: DataTableSummary) => void }) {
  const [open, setOpen] = useState(focus);
  const [rows, setRows] = useState<DataRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const bodyId = `source-table-${table.id}`;

  // The citation's target: expand and bring it into view.
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focus]);

  useEffect(() => {
    if (!open || rows !== null) return;
    let cancelled = false;
    api<TableResponse>(`/api/data/tables/${encodeURIComponent(table.id)}?limit=${LIBRARY_PREVIEW_ROWS}`)
      .then((r) => !cancelled && setRows(r.rows))
      .catch((e) => {
        if (cancelled) return;
        setRows([]);
        setError(errorText(e, "Couldn't load the rows."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, rows, table.id]);

  const toggleHidden = async () => {
    setBusy(true);
    setError(null);
    try {
      const { table: t } = await api<TablePatchResponse>(`/api/data/tables/${encodeURIComponent(table.id)}`, {
        method: "PATCH",
        json: { op: table.status === "hidden" ? "unhide" : "hide" },
      });
      onChanged(t);
    } catch (e) {
      setError(errorText(e, "That change didn't save."));
    } finally {
      setBusy(false);
    }
  };

  const where = tableLocation(table);
  const chips = statusChips(table);

  return (
    <div
      ref={ref}
      tabIndex={focus ? -1 : undefined}
      className={`scroll-mt-4 rounded-lg border px-3 py-2 ${focus ? "border-[var(--go-line)] ring-2 ring-[var(--go-soft-strong)]" : "border-[var(--doc-line)]"}`}
    >
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full items-start gap-1.5 text-left sm:min-h-8">
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" aria-hidden /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" aria-hidden />}
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium">{table.name}</span>
          <span className="block text-xs text-[var(--doc-muted)]">{[where, methodLabel(table.extraction_method), shapeText(table)].filter(Boolean).join(" · ")}</span>
        </span>
      </button>
      {chips.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c.key} title={c.title} className="rounded-full bg-[var(--doc-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--doc-muted)]">
              {c.label}
            </span>
          ))}
        </div>
      )}
      {open && (
        <div id={bodyId} className="mt-2 space-y-2">
          {table.notes && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{table.notes}</p>}
          {rows === null ? (
            <p className="flex items-center gap-2 text-xs text-[var(--doc-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading rows…
            </p>
          ) : rows.length > 0 ? (
            <DataTablePreview table={table} rows={rows} caption={`${table.name}: first ${rows.length} of ${table.row_count} rows`} />
          ) : null}
          <div className="flex flex-wrap items-center gap-1">
            {table.status !== "superseded" && (
              <button
                type="button"
                onClick={() => void toggleHidden()}
                disabled={busy}
                className="flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-50 sm:min-h-0"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : table.status === "hidden" ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
                {table.status === "hidden" ? "Unhide" : "Hide"}
              </button>
            )}
            <a
              href={`/api/data/tables/${encodeURIComponent(table.id)}/csv`}
              download
              className="flex min-h-11 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)] sm:min-h-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
            </a>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
