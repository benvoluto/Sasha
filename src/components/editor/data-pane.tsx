"use client";

// The Data tab (PLAN §6.6, phase5-spec.md §5.2): the tables linked to the
// document, each a card with where it came from, its status, a typed preview
// (cells and columns editable in place) and its actions: Insert into the
// document, Download CSV, Rename, Hide, Mark as replaced, Restore, Use newer
// table, Remove from document. "Add table" links one from the document's
// sources or the library.
//
// Opened from "Add" on a data suggestion it carries a prefill: a banner says
// what is being added for, the picker opens searching its label, and the first
// table linked while the prefill is active marks the suggestion added.
//
// While a linked source is still being read the tab says so, and loads the
// tables again when reading finishes (tables are written before a source's
// final status). Pure logic lives in data-pane-model.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, MoreVertical, Plus, Search, Table as TableIcon, X } from "@/components/icons";
import { api, errorText, isBusy, mergeFresh, styles, usePollSources, type LinkedSource } from "@/components/sources/shared";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  DataTablePatch,
  DataTableSummary,
  DocumentDataResponse,
  LinkedDataTable,
  TablePatchResponse,
  TableListResponse,
  TableResponse,
  TableSnapshot,
  DataRow,
} from "@/lib/data/contract";
import type { DataPrefill, SuggestionResponse } from "@/lib/suggestions/contract";
import {
  appendRows,
  canUseNewer,
  collectRows,
  insertChoices,
  mergeTable,
  methodLabel,
  MORE_ROWS_PAGE,
  prefillCompletion,
  PREVIEW_ROWS,
  readingText,
  replaceRow,
  replacementCandidates,
  shapeText,
  statusChips,
  tableMeta,
  type ChipTone,
} from "./data-pane-model";
import { DataTablePicker } from "./data-table-picker";
import { DataTablePreview } from "./data-table-preview";

const docData = (id: string) => `/api/documents/${encodeURIComponent(id)}/data`;
const tableUrl = (id: string) => `/api/data/tables/${encodeURIComponent(id)}`;

const CHIP_TONE: Record<ChipTone, string> = {
  quiet: "bg-[var(--doc-accent-soft)] text-[var(--doc-muted)]",
  warn: "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  accent: "bg-[var(--go-soft)] text-[var(--go)]",
};

const pill = "flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium sm:min-h-9";

export function DataPane({
  documentId,
  ensureSaved,
  onInsertTable,
  prefill = null,
  onPrefillDone,
  onGoToSources,
}: {
  documentId: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** Inserts a snapshot at the editor's cursor; "Insert" is disabled without it. */
  onInsertTable?: (snapshot: TableSnapshot) => void;
  /** Opened from "Add" on a data suggestion: show what it's for, and mark it added once a table is linked. */
  prefill?: DataPrefill | null;
  /** The prefill was used (a table was linked for it) or dismissed. */
  onPrefillDone?: () => void;
  /** The empty state's "Go to Sources". */
  onGoToSources?: () => void;
}) {
  const [tables, setTables] = useState<LinkedDataTable[] | null>(documentId ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<LinkedSource[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  /** The button the picker was opened from; it gets focus back when the picker closes. */
  const pickerFrom = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setTables([]);
      return;
    }
    try {
      const { tables: list } = await api<DocumentDataResponse>(docData(id));
      setTables(list);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Couldn't load the tables."));
      setTables((t) => t ?? []);
    }
  }, []);

  useEffect(() => {
    void load(documentId);
  }, [documentId, load]);

  // The linked sources, so the tab can say when some are still being read.
  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    api<{ sources: LinkedSource[] }>(`/api/documents/${encodeURIComponent(documentId)}/sources`)
      .then(({ sources: list }) => !cancelled && setSources(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [documentId]);
  usePollSources(sources, (fresh) => setSources((list) => mergeFresh(list, fresh)));
  const busyCount = sources.filter(isBusy).length;
  // A source finished reading: its tables are in now.
  const lastBusy = useRef(busyCount);
  useEffect(() => {
    if (busyCount < lastBusy.current) void load(documentId);
    lastBusy.current = busyCount;
  }, [busyCount, documentId, load]);

  // A prefill opens the picker on its label.
  const prefillId = prefill?.suggestionId ?? null;
  useEffect(() => {
    setPrefillError(null);
    if (!prefillId) return;
    pickerFrom.current = findButton.current;
    setPickerOpen(true);
  }, [prefillId]);
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  const markPrefill = async (docId: string, tableId: string) => {
    const p = prefillRef.current;
    const done = prefillCompletion(p, tableId);
    if (!p || !done) return;
    try {
      await api<SuggestionResponse>(`/api/documents/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(done.suggestionId)}`, { method: "PATCH", json: done.body });
      if (prefillRef.current?.suggestionId === p.suggestionId) {
        setPrefillError(null);
        onPrefillDone?.();
      }
    } catch (e) {
      setPrefillError(errorText(e, `The table was added, but "${p.label}" couldn't be marked done.`));
    }
  };

  /** Link a table to the document (saving it first); resolves to an error message or null. */
  const link = async (table: DataTableSummary): Promise<string | null> => {
    const id = await ensureSaved();
    if (!id) return "Save the document before adding tables.";
    try {
      const { table: linked } = await api<{ table: LinkedDataTable }>(docData(id), { method: "POST", json: { table_id: table.id } });
      setTables((list) => (list?.some((t) => t.id === linked.id) ? mergeTable(list, linked) : [...(list ?? []), linked]));
      await markPrefill(id, linked.id);
      return null;
    } catch (e) {
      return errorText(e, "Couldn't add the table.");
    }
  };

  const openPicker = async () => {
    if (!documentId && !(await ensureSaved())) {
      setError("Save the document before adding tables.");
      return;
    }
    pickerFrom.current = addButton.current;
    setPickerOpen(true);
  };

  const list = tables ?? [];
  const reading = readingText(busyCount);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-3 sm:px-6">
        <button
          ref={addButton}
          type="button"
          onClick={() => void openPicker()}
          className="flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 text-sm font-semibold text-[var(--doc-on-accent)] sm:min-h-9"
        >
          <Plus className="h-4 w-4" aria-hidden /> Add table
        </button>
        <p aria-live="polite" className="flex min-h-5 items-center gap-1.5 text-xs text-[var(--doc-muted)]">
          {reading && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {reading}
            </>
          )}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6 sm:px-6">
        {prefill && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--go-soft)] px-3 py-2 text-sm text-[var(--go)]">
            <span className="min-w-0 flex-1 break-words">
              Adding for: <span className="font-semibold">{prefill.label}</span>
            </span>
            <button
              ref={findButton}
              type="button"
              onClick={() => {
                pickerFrom.current = findButton.current;
                setPickerOpen(true);
              }}
              className="flex min-h-11 items-center gap-1 rounded-full px-2.5 text-xs font-semibold hover:bg-[var(--go-soft-strong)] sm:min-h-9"
            >
              <Search className="h-3.5 w-3.5" aria-hidden /> Find a table
            </button>
            <button
              type="button"
              onClick={() => onPrefillDone?.()}
              className="flex min-h-11 items-center gap-1 rounded-full px-2.5 text-xs font-semibold hover:bg-[var(--go-soft-strong)] sm:min-h-9"
            >
              <X className="h-3.5 w-3.5" aria-hidden /> Cancel
            </button>
            {prefillError && (
              <p role="alert" className="basis-full text-xs text-red-600 dark:text-red-400">
                {prefillError}
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {!documentId ? (
          <p className="text-sm text-[var(--doc-muted)]">Tables appear once the document is saved.</p>
        ) : tables === null ? (
          <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading tables…
          </p>
        ) : list.length === 0 ? (
          <div className="space-y-2 rounded-xl border border-dashed border-[var(--doc-line)] px-4 py-5 text-sm text-[var(--doc-muted)]">
            <p>No tables yet. Add a CSV or spreadsheet in Sources, or a PDF that has tables.</p>
            {onGoToSources && (
              <button type="button" onClick={onGoToSources} className={`${pill} -ml-3 text-[var(--go)] hover:bg-[var(--go-soft)]`}>
                Go to Sources
              </button>
            )}
          </div>
        ) : (
          <ul className="space-y-3">
            {list.map((t) => (
              <li key={t.id}>
                <TableCard
                  table={t}
                  documentId={documentId}
                  linked={list}
                  onInsertTable={onInsertTable}
                  onChanged={(next) => setTables((l) => (l ? mergeTable(l, next) : l))}
                  onRemoved={() => {
                    setTables((l) => l?.filter((x) => x.id !== t.id) ?? null);
                    addButton.current?.focus();
                  }}
                  onReplaced={(next) => {
                    setTables((l) => {
                      const rest = (l ?? []).filter((x) => x.id !== t.id);
                      return rest.some((x) => x.id === next.id) ? rest : [...rest, next];
                    });
                    addButton.current?.focus();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <DataTablePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        documentId={documentId}
        linkedIds={list.map((t) => t.id)}
        initialQuery={prefill?.label ?? ""}
        pickLinked={!!prefill}
        onPick={link}
        // Back where it was opened, or to "Add table" once that button has gone
        // (a prefill's "Find a table" leaves when the prefill is done).
        returnFocus={() => (pickerFrom.current?.isConnected ? pickerFrom.current : addButton.current)}
      />
    </div>
  );
}

type Inline = "rename" | "replace" | "remove" | null;

function TableCard({
  table,
  documentId,
  linked,
  onInsertTable,
  onChanged,
  onRemoved,
  onReplaced,
}: {
  table: LinkedDataTable;
  documentId: string;
  linked: LinkedDataTable[];
  onInsertTable?: (snapshot: TableSnapshot) => void;
  onChanged: (table: DataTableSummary) => void;
  onRemoved: () => void;
  /** "Use newer table": the newer one is linked and this one unlinked. */
  onReplaced: (next: LinkedDataTable) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DataRow[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [inline, setInline] = useState<Inline>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  // An inline form opened from the menu takes focus once the menu has closed
  // (the menu traps focus while open, so autoFocus can't).
  const focusInline = useRef(false);
  const inlineFirst = useRef<HTMLElement | null>(null);
  const bodyId = `data-card-${table.id}`;

  const loadRows = useCallback(
    async (offset: number, limit: number) => {
      setLoadingRows(true);
      try {
        const page = await api<TableResponse>(`${tableUrl(table.id)}?offset=${offset}&limit=${limit}`);
        setRows((r) => appendRows(offset === 0 ? [] : (r ?? []), page.rows));
        setNextOffset(page.next_offset);
        setError(null);
      } catch (e) {
        setError(errorText(e, "Couldn't load the rows."));
        setRows((r) => r ?? []);
      } finally {
        setLoadingRows(false);
      }
    },
    [table.id],
  );

  useEffect(() => {
    if (open && rows === null) void loadRows(0, PREVIEW_ROWS);
  }, [open, rows, loadRows]);

  const patch = useCallback(
    async (p: DataTablePatch): Promise<string | null> => {
      try {
        const res = await api<TablePatchResponse>(tableUrl(table.id), { method: "PATCH", json: p });
        onChanged(res.table);
        if (res.row) setRows((r) => (r ? replaceRow(r, res.row!) : r));
        return null;
      } catch (e) {
        return errorText(e, "That change didn't save.");
      }
    },
    [table.id, onChanged],
  );

  const run = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    setError(null);
    const err = await fn();
    setBusy(null);
    if (err) setError(err);
    return !err;
  };

  const closeInline = () => {
    setInline(null);
    menuTrigger.current?.focus();
  };

  const openInline = (mode: Inline) => {
    focusInline.current = true;
    setInline(mode);
  };

  const switchToNewer = () =>
    run("newer", async () => {
      if (!table.superseded_by) return null;
      try {
        const { table: next } = await api<{ table: LinkedDataTable }>(docData(documentId), { method: "POST", json: { table_id: table.superseded_by } });
        await api(`${docData(documentId)}/${encodeURIComponent(table.id)}`, { method: "DELETE" });
        onReplaced(next);
        return null;
      } catch (e) {
        return errorText(e, "Couldn't switch to the newer table.");
      }
    });

  const remove = () =>
    run("remove", async () => {
      try {
        await api(`${docData(documentId)}/${encodeURIComponent(table.id)}`, { method: "DELETE" });
        onRemoved();
        return null;
      } catch (e) {
        return errorText(e, "Couldn't remove the table.");
      }
    });

  const chips = statusChips(table);
  const csvHref = `${tableUrl(table.id)}/csv`;

  return (
    <article aria-label={table.name} className="rounded-xl border border-[var(--doc-line)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 min-w-0 flex-1 items-start gap-1.5 text-left sm:min-h-9"
        >
          {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" aria-hidden /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" aria-hidden />}
          <span className="min-w-0">
            <span className="block break-words text-sm font-semibold leading-snug hover:text-[var(--go)]">{table.name}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--doc-muted)]">
              <span className="min-w-0 break-words">{tableMeta(table)}</span>
              <span className="rounded bg-[var(--doc-accent-soft)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide">{methodLabel(table.extraction_method)}</span>
              <span>{shapeText(table)}</span>
            </span>
          </span>
        </button>
        <InsertButton table={table} onInsertTable={onInsertTable} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={menuTrigger}
              type="button"
              aria-label={`Actions for ${table.name}`}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)] sm:h-9 sm:w-9"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MoreVertical className="h-4 w-4" aria-hidden />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-52 font-sans"
            onCloseAutoFocus={(e) => {
              const el = inlineFirst.current;
              if (focusInline.current && el?.isConnected) {
                e.preventDefault();
                el.focus();
              }
              focusInline.current = false;
            }}
          >
            <DropdownMenuItem asChild className="min-h-11 sm:min-h-8">
              <a href={csvHref} download>
                <Download className="h-4 w-4" aria-hidden /> Download CSV
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => openInline("rename")}>
              Rename…
            </DropdownMenuItem>
            {table.status === "active" && (
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => void run("hide", () => patch({ op: "hide" }))}>
                Hide
              </DropdownMenuItem>
            )}
            {table.status === "hidden" && (
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => void run("unhide", () => patch({ op: "unhide" }))}>
                Unhide
              </DropdownMenuItem>
            )}
            {table.status === "active" && (
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => openInline("replace")}>
                Mark as replaced by…
              </DropdownMenuItem>
            )}
            {table.status === "superseded" && (
              <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => void run("restore", () => patch({ op: "restore" }))}>
                Restore
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className="min-h-11 sm:min-h-8" onSelect={() => openInline("remove")}>
              Remove from document…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(chips.length > 0 || canUseNewer(table)) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span key={c.key} title={c.title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${CHIP_TONE[c.tone]}`}>
              {c.label}
            </span>
          ))}
          {canUseNewer(table) && (
            <button
              type="button"
              onClick={() => void switchToNewer()}
              disabled={!!busy}
              className="flex min-h-11 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-[var(--go)] hover:bg-[var(--go-soft)] disabled:opacity-50 sm:min-h-8"
            >
              {busy === "newer" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Use newer table
            </button>
          )}
        </div>
      )}

      {inline === "rename" && (
        <RenameForm
          initial={table.name}
          firstRef={inlineFirst}
          busy={busy === "rename"}
          onCancel={closeInline}
          onSave={async (name) => {
            if (name === table.name || (await run("rename", () => patch({ op: "rename", name })))) closeInline();
          }}
        />
      )}
      {inline === "replace" && (
        <ReplaceForm
          table={table}
          linked={linked}
          firstRef={inlineFirst}
          busy={busy === "supersede"}
          onCancel={closeInline}
          onPick={async (by) => {
            if (await run("supersede", () => patch({ op: "supersede", by }))) closeInline();
          }}
        />
      )}
      {inline === "remove" && (
        <div role="alertdialog" aria-label="Remove this table from the document?" className="mt-2 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100">
          <p>Remove this table from the document? It stays in the library, and tables already inserted stay as they are.</p>
          <div className="flex gap-1.5">
            <button
              ref={(el) => {
                inlineFirst.current = el;
              }}
              type="button"
              onClick={() => void remove()}
              disabled={!!busy}
              className="flex min-h-11 items-center gap-1.5 rounded-md bg-red-700 px-3 font-semibold text-white disabled:opacity-50 sm:min-h-9"
            >
              {busy === "remove" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Remove
            </button>
            <button type="button" onClick={closeInline} className="min-h-11 rounded-md px-2 sm:min-h-9">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {open && (
        <div id={bodyId} className="mt-2.5 space-y-2">
          {table.notes && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{table.notes}</p>}
          {rows === null ? (
            <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading rows…
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-[var(--doc-muted)]">No rows.</p>
          ) : (
            <>
              <DataTablePreview table={table} rows={rows} caption={`${table.name}: rows 1 to ${rows.length} of ${table.row_count}`} onPatch={patch} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--doc-muted)]">
                <span>
                  Showing {rows.length.toLocaleString("en-US")} of {table.row_count.toLocaleString("en-US")} rows. Select a cell or column name to change it.
                </span>
                {nextOffset !== null && (
                  <button
                    type="button"
                    onClick={() => void loadRows(nextOffset, MORE_ROWS_PAGE)}
                    disabled={loadingRows}
                    className="flex min-h-11 items-center gap-1 rounded-full px-2.5 font-semibold text-[var(--go)] hover:bg-[var(--go-soft)] disabled:opacity-50 sm:min-h-8"
                  >
                    {loadingRows && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Show more rows
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/** "Insert": choose how many rows, fetch them and hand the snapshot to the editor. */
function InsertButton({ table, onInsertTable }: { table: DataTableSummary; onInsertTable?: (snapshot: TableSnapshot) => void }) {
  const { choices, initial } = insertChoices(table.row_count);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = !onInsertTable || choices.length === 0;
  const groupName = `insert-${table.id}`;

  const insert = async () => {
    if (!onInsertTable) return;
    setBusy(true);
    setError(null);
    try {
      const { table: fresh, rows } = await collectRows((offset, limit) => api<TableResponse>(`${tableUrl(table.id)}?offset=${offset}&limit=${limit}`), count);
      setOpen(false);
      onInsertTable({ table: fresh ?? table, rows });
    } catch (e) {
      setError(errorText(e, "Couldn't load the rows to insert."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setCount(initial);
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={onInsertTable ? undefined : "Open the document to insert tables"}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-[var(--doc-accent)] px-3 text-xs font-semibold text-[var(--doc-on-accent)] disabled:opacity-40 sm:min-h-9"
        >
          <TableIcon className="h-3.5 w-3.5" aria-hidden /> Insert
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(16rem,calc(100vw-2rem))] rounded-xl border-[var(--doc-line)] bg-[var(--doc-surface)] p-3 font-sans text-[var(--doc-ink)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void insert();
          }}
          className="space-y-2"
        >
          <fieldset className="space-y-0.5">
            <legend className="mb-1 text-xs font-medium text-[var(--doc-muted)]">Rows to insert</legend>
            {choices.map((c) => (
              <label key={c.value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm hover:bg-[var(--go-soft)] sm:min-h-8">
                <input type="radio" name={groupName} value={c.value} checked={count === c.value} onChange={() => setCount(c.value)} className="accent-[var(--go)]" />
                {c.label}
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || count < 1} className={`${styles.primary} min-h-11 w-full justify-center sm:min-h-9`}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Insert table
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function RenameForm({
  initial,
  busy,
  firstRef,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  firstRef: React.RefObject<HTMLElement | null>;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const id = `rename-${initial.length}-${initial.slice(0, 8).replace(/\W/g, "")}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
      className="mt-2 space-y-1.5"
    >
      <label htmlFor={id} className="block text-xs font-medium text-[var(--doc-muted)]">
        Table name
      </label>
      <input
        id={id}
        ref={(el) => {
          firstRef.current = el;
        }}
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
        className={`${styles.field} min-h-11 sm:min-h-9`}
      />
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !name.trim()} className={`${styles.primary} min-h-11 sm:min-h-9`}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Save
        </button>
        <button type="button" onClick={onCancel} className={`${styles.quiet} min-h-11 sm:min-h-9`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** "Mark as replaced by…": the same source's other active tables, then the other linked ones. */
function ReplaceForm({
  table,
  linked,
  busy,
  firstRef,
  onPick,
  onCancel,
}: {
  table: DataTableSummary;
  linked: DataTableSummary[];
  busy: boolean;
  firstRef: React.RefObject<HTMLElement | null>;
  onPick: (by: string) => void;
  onCancel: () => void;
}) {
  const [sameSource, setSameSource] = useState<DataTableSummary[] | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<TableListResponse>(`/api/data/tables?source_id=${encodeURIComponent(table.source_id)}`)
      .then(({ tables }) => !cancelled && setSameSource(tables))
      .catch((e) => {
        if (cancelled) return;
        setSameSource([]);
        setError(errorText(e, "Couldn't load the other tables."));
      });
    return () => {
      cancelled = true;
    };
  }, [table.source_id]);

  const candidates = sameSource ? replacementCandidates(table, sameSource, linked) : [];
  const groupName = `replace-${table.id}`;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) onPick(choice);
      }}
      className="mt-2 space-y-2 rounded-lg border border-[var(--doc-line)] p-3"
    >
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-[var(--doc-muted)]">Replaced by</legend>
        {sameSource === null ? (
          <p className="flex items-center gap-2 py-1 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading tables…
          </p>
        ) : candidates.length === 0 ? (
          <p className="py-1 text-sm text-[var(--doc-muted)]">No other active tables from this source or on this document.</p>
        ) : (
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {candidates.map((c, i) => (
              <label key={c.id} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--go-soft)] sm:min-h-8">
                <input
                  ref={
                    i === 0
                      ? (el) => {
                          firstRef.current = el;
                        }
                      : undefined
                  }
                  type="radio"
                  name={groupName}
                  value={c.id}
                  checked={choice === c.id}
                  onChange={() => setChoice(c.id)}
                  className="mt-1 accent-[var(--go)]"
                />
                <span className="min-w-0">
                  <span className="block break-words font-medium">{c.name}</span>
                  <span className="block break-words text-xs text-[var(--doc-muted)]">
                    {tableMeta(c)} · {shapeText(c)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !choice} className={`${styles.primary} min-h-11 sm:min-h-9`}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Mark replaced
        </button>
        <button
          ref={
            candidates.length === 0
              ? (el) => {
                  firstRef.current = el;
                }
              : undefined
          }
          type="button"
          onClick={onCancel}
          className={`${styles.quiet} min-h-11 sm:min-h-9`}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
