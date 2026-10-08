"use client";

// A data table's rows as a real <table> (phase5-spec.md §5.2): a sr-only
// caption, scope="col" headers each with a type badge, numeric columns on the
// right, and a dot on cells a person changed. It scrolls sideways inside its
// box, never the page. Used by the Data tab's cards and the library drawer.
//
// With `onPatch` it is editable: a cell (click, or Enter on its button) opens a
// small popover to change the value or go back to the source's; a column
// header opens rename, the type and "Use detected type". Focus returns to the
// cell or header afterwards.

import { useRef, useState } from "react";
import { Calendar, Loader2 } from "@/components/icons";
import { styles } from "@/components/sources/shared";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COLUMN_TYPES, isNumericType, type ColumnType, type DataColumn, type DataRow, type DataTablePatch, type DataTableSummary } from "@/lib/data/contract";
import { cellAt, cellEdit, overrideTitle, TYPE_NAMES, typeBadge, typeChanged } from "./data-pane-model";

/** Applies one change; resolves to an error message, or null when it saved. */
export type PatchFn = (patch: DataTablePatch) => Promise<string | null>;

const popover = "w-[min(18rem,calc(100vw-2rem))] rounded-xl border-[var(--doc-line)] bg-[var(--doc-surface)] p-3 font-sans text-[var(--doc-ink)]";

export function TypeBadge({ column }: { column: Pick<DataColumn, "type" | "unit"> }) {
  const b = typeBadge(column);
  return (
    <span
      role="img"
      aria-label={b.label}
      title={b.label}
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-[var(--go-soft)] px-1 text-[10px] font-semibold leading-none text-[var(--go)]"
    >
      {b.icon === "calendar" ? <Calendar className="h-3 w-3" aria-hidden /> : <span aria-hidden>{b.text}</span>}
    </span>
  );
}

export function DataTablePreview({ table, rows, caption, onPatch }: { table: DataTableSummary; rows: DataRow[]; caption: string; onPatch?: PatchFn }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // The cell being edited; its button anchors the popover and gets focus back.
  const [editing, setEditing] = useState<{ row: DataRow; index: number } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const lastCell = useRef<string | null>(null);

  const openCell = (row: DataRow, index: number, el: HTMLElement) => {
    anchor.current = el;
    lastCell.current = `${row.idx}:${index}`;
    setEditing({ row, index });
  };

  // The row may have been replaced by the save; read the current one.
  const current = editing ? (rows.find((r) => r.idx === editing.row.idx) ?? editing.row) : null;

  return (
    <div ref={wrapRef} className="max-w-full overflow-x-auto rounded-lg border border-[var(--doc-line)]">
      <table className="w-max min-w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={`border-b border-[var(--doc-line)] bg-[var(--doc-accent-soft)] px-2 py-1.5 font-semibold ${isNumericType(c.type) ? "text-right" : "text-left"}`}
              >
                {onPatch ? <ColumnMenu column={c} index={i} onPatch={onPatch} /> : <ColumnLabel column={c} />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.idx} className="border-b border-[var(--doc-line)] last:border-b-0">
              {table.columns.map((c, i) => {
                const { value, override } = cellAt(r, c, i);
                const numeric = isNumericType(c.type);
                const title = override ? overrideTitle(override) : undefined;
                const content = (
                  <>
                    {override && <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--go)] align-middle" />}
                    <span className="whitespace-pre-wrap break-words">{value ?? ""}</span>
                    {override && <span className="sr-only"> (changed)</span>}
                  </>
                );
                return (
                  <td key={c.key} className={`max-w-[18rem] p-0 align-top ${numeric ? "text-right tabular-nums" : "text-left"}`}>
                    {onPatch ? (
                      <button
                        type="button"
                        data-cell={`${r.idx}:${i}`}
                        title={title ?? "Change this cell"}
                        aria-label={`${c.label}, row ${r.idx + 1}: ${value ?? "empty"}${override ? " (changed)" : ""}. Change`}
                        onClick={(e) => openCell(r, i, e.currentTarget)}
                        className={`block min-h-11 w-full px-2 py-1.5 hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--go)] sm:min-h-8 ${numeric ? "text-right" : "text-left"}`}
                      >
                        {content}
                      </button>
                    ) : (
                      <div title={title} className="px-2 py-1.5">
                        {content}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {onPatch && (
        <Popover open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
          <PopoverAnchor virtualRef={anchor as React.RefObject<HTMLElement>} />
          <PopoverContent
            align="start"
            className={popover}
            onCloseAutoFocus={(e) => {
              // The anchor isn't a Radix trigger: put focus back on the cell ourselves.
              e.preventDefault();
              const el = anchor.current?.isConnected ? anchor.current : wrapRef.current?.querySelector<HTMLElement>(`[data-cell="${lastCell.current}"]`);
              el?.focus();
            }}
          >
            {editing && current && (
              <CellForm
                key={`${current.idx}:${editing.index}`}
                column={table.columns[editing.index]}
                row={current}
                index={editing.index}
                onPatch={onPatch}
                onDone={() => setEditing(null)}
              />
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function ColumnLabel({ column }: { column: DataColumn }) {
  return (
    <span className={`flex items-center gap-1.5 ${isNumericType(column.type) ? "justify-end" : ""}`}>
      <span className="break-words">{column.label}</span>
      <TypeBadge column={column} />
    </span>
  );
}

function CellForm({ column, row, index, onPatch, onDone }: { column: DataColumn; row: DataRow; index: number; onPatch: PatchFn; onDone: () => void }) {
  const { value, override } = cellAt(row, column, index);
  const [text, setText] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `cell-${row.idx}-${column.key}`;

  const run = async (patch: DataTablePatch | null) => {
    if (!patch) return onDone();
    setBusy(true);
    setError(null);
    const err = await onPatch(patch);
    setBusy(false);
    if (err) setError(err);
    else onDone();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run(cellEdit(row, column, index, text));
      }}
      className="space-y-2"
    >
      <label htmlFor={id} className="block text-xs font-medium text-[var(--doc-muted)]">
        {column.label}, row {row.idx + 1}
      </label>
      <input id={id} autoFocus value={text} onChange={(e) => setText(e.target.value)} className={styles.field} />
      {override && <p className="text-xs text-[var(--doc-muted)]">{overrideTitle(override)}.</p>}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="submit" disabled={busy} className={`${styles.primary} min-h-11 sm:min-h-9`}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Save
        </button>
        {override && (
          <button type="button" disabled={busy} onClick={() => void run({ op: "revert", row: row.idx, key: column.key })} className={`${styles.quiet} min-h-11 sm:min-h-9`}>
            Use source value
          </button>
        )}
      </div>
    </form>
  );
}

function ColumnMenu({ column, index, onPatch }: { column: DataColumn; index: number; onPatch: PatchFn }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(column.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `col-${column.key}`;

  const run = async (patch: DataTablePatch, close: boolean) => {
    setBusy(true);
    setError(null);
    const err = await onPatch(patch);
    setBusy(false);
    if (err) setError(err);
    else if (close) setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setLabel(column.label);
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Column ${index + 1}: ${column.label}, ${typeBadge(column).label}. Change column`}
          className={`flex min-h-11 w-full items-center gap-1.5 rounded px-0.5 hover:text-[var(--go)] focus-visible:outline-2 focus-visible:outline-[var(--go)] sm:min-h-7 ${isNumericType(column.type) ? "justify-end" : ""}`}
        >
          <span className="break-words">{column.label}</span>
          <TypeBadge column={column} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={popover}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const next = label.trim();
            if (next && next !== column.label) void run({ op: "column", key: column.key, label: next }, true);
            else setOpen(false);
          }}
          className="space-y-2"
        >
          <label htmlFor={`${id}-label`} className="block text-xs font-medium text-[var(--doc-muted)]">
            Column name
          </label>
          <input id={`${id}-label`} autoFocus value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} className={styles.field} />
          <button type="submit" disabled={busy || !label.trim()} className={`${styles.primary} min-h-11 sm:min-h-9`}>
            Rename
          </button>
        </form>
        <div className="mt-3 space-y-1.5 border-t border-[var(--doc-line)] pt-3">
          <label htmlFor={`${id}-type`} className="block text-xs font-medium text-[var(--doc-muted)]">
            Type
          </label>
          <select
            id={`${id}-type`}
            value={column.type}
            disabled={busy}
            onChange={(e) => void run({ op: "column", key: column.key, type: e.target.value as ColumnType }, false)}
            className={`${styles.field} min-h-11 bg-[var(--doc-surface)] sm:min-h-9`}
          >
            {COLUMN_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_NAMES[t]}
                {t === column.inferred ? " (detected)" : ""}
              </option>
            ))}
          </select>
          {typeChanged(column) && (
            <button type="button" disabled={busy} onClick={() => void run({ op: "column", key: column.key, type: null }, false)} className={`${styles.quiet} min-h-11 sm:min-h-9`}>
              Use detected type ({TYPE_NAMES[column.inferred]})
            </button>
          )}
        </div>
        {busy && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--doc-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Saving…
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
