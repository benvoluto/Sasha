// Pure logic for the Data tab (data-pane.tsx) and the library's Tables section
// (source-tables.tsx): what a table card says about a table, the row counts
// "Insert table" offers, the add-table picker's groups, candidates for "Mark
// as replaced by…", paging rows for a preview or an insert, and finishing a
// suggestion's prefill once a table is linked. Client-safe.

import {
  DEFAULT_INSERT_ROWS,
  INSERT_ROW_OPTIONS,
  MAX_INSERT_ROWS,
  MAX_ROWS_PAGE,
  tableLocation,
  type CellOverride,
  type DataColumn,
  type DataRow,
  type DataTableSource,
  type DataTableSummary,
  type ExtractionMethod,
  type TableResponse,
} from "@/lib/data/contract";
import type { DataPrefill, SuggestionActionRequest } from "@/lib/suggestions/contract";

/** Rows an expanded card shows first, and each "Show more rows" page after that. */
export const PREVIEW_ROWS = 10;
export const MORE_ROWS_PAGE = 100;
/** Rows the library drawer's collapsed preview shows. */
export const LIBRARY_PREVIEW_ROWS = 5;
/** A Gemini table below this confidence gets the "Low confidence" chip. */
export const LOW_CONFIDENCE = 0.6;
/** The add-table picker's library search waits this long after typing. */
export const SEARCH_DEBOUNCE_MS = 250;

// --- What a card says -------------------------------------------------------------

const METHOD_LABELS: Record<ExtractionMethod, string> = {
  csv: "CSV",
  xlsx: "Spreadsheet",
  "gemini-pdf": "PDF",
  "gemini-image": "Image",
};
export const methodLabel = (m: ExtractionMethod) => METHOD_LABELS[m] ?? m;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "12 rows × 4 columns". */
export const shapeText = (t: Pick<DataTableSummary, "row_count" | "columns">) => `${plural(t.row_count, "row")} × ${plural(t.columns.length, "column")}`;

export const tableSourceTitle = (s: Pick<DataTableSource, "title" | "filename">) => s.title || s.filename || "Untitled source";

/** The card's second line: "Budget.xlsx · Sheet: 2024" (the method is a chip beside it). */
export const tableMeta = (t: Pick<DataTableSummary, "source" | "sheet" | "page" | "page_end">) => [tableSourceTitle(t.source), tableLocation(t)].filter(Boolean).join(" · ");

export type ChipTone = "quiet" | "warn" | "accent";
export type StatusChip = { key: "hidden" | "superseded" | "low_confidence" | "truncated" | "changed"; label: string; tone: ChipTone; title?: string };

/** The chips a table card shows, in this order. */
export function statusChips(t: Pick<DataTableSummary, "status" | "confidence" | "truncated" | "override_count" | "notes">): StatusChip[] {
  const out: StatusChip[] = [];
  if (t.status === "hidden") out.push({ key: "hidden", label: "Hidden", tone: "quiet" });
  if (t.status === "superseded") out.push({ key: "superseded", label: "Superseded", tone: "warn" });
  if (t.confidence !== null && t.confidence < LOW_CONFIDENCE) out.push({ key: "low_confidence", label: "Low confidence", tone: "warn", title: "Check the cells against the file." });
  if (t.truncated) out.push({ key: "truncated", label: "Truncated", tone: "quiet", title: t.notes || "Some rows or columns were left out." });
  if (t.override_count > 0) out.push({ key: "changed", label: plural(t.override_count, "changed cell"), tone: "accent" });
  return out;
}

/** "Use newer table" is offered on a superseded table that names its replacement. */
export const canUseNewer = (t: Pick<DataTableSummary, "status" | "superseded_by">) => t.status === "superseded" && !!t.superseded_by;

export type TypeBadge = { text: string; label: string; icon?: "calendar" };

/** The badge in a column header, with the words a screen reader hears. */
export function typeBadge(c: Pick<DataColumn, "type" | "unit">): TypeBadge {
  switch (c.type) {
    case "number":
      return { text: "123", label: "Number" };
    case "currency":
      return { text: c.unit || "$", label: c.unit ? `Currency (${c.unit})` : "Currency" };
    case "percent":
      return { text: "%", label: "Percent" };
    case "date":
      return { text: "", label: "Date", icon: "calendar" };
    default:
      return { text: "Aa", label: "Text" };
  }
}

export const TYPE_NAMES = { number: "Number", currency: "Currency", percent: "Percent", date: "Date", text: "Text" } as const;

/** The title on a changed cell: Changed from "x" by Ana, 8 Oct 2026. */
export function overrideTitle(o: CellOverride, locale?: string): string {
  const d = new Date(o.at);
  const date = Number.isNaN(d.getTime()) ? o.at : d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  return `Changed from ${o.original === null || o.original === "" ? "empty" : `"${o.original}"`} by ${o.by || "someone"}, ${date}`;
}

/** Whether a column has been given a type other than the detected one. */
export const typeChanged = (c: Pick<DataColumn, "type" | "inferred">) => c.type !== c.inferred;

// --- Insert table -----------------------------------------------------------------

export type InsertChoice = { value: number; label: string };

/**
 * The row counts "Insert table" offers for a table of `rowCount` rows: the
 * standard counts below it, plus "All N" when the whole table fits; and which
 * one is chosen first (DEFAULT_INSERT_ROWS, or all when the table is smaller).
 */
export function insertChoices(rowCount: number): { choices: InsertChoice[]; initial: number } {
  const n = Math.max(0, rowCount);
  const fitsAll = n <= MAX_INSERT_ROWS;
  const choices: InsertChoice[] = INSERT_ROW_OPTIONS.filter((v) => (fitsAll ? v < n : v <= MAX_INSERT_ROWS)).map((v) => ({ value: v, label: `First ${v}` }));
  if (fitsAll && n > 0) choices.push({ value: n, label: `All ${n.toLocaleString("en-US")}` });
  const initial = Math.min(DEFAULT_INSERT_ROWS, n);
  return { choices, initial: choices.some((c) => c.value === initial) ? initial : (choices.at(-1)?.value ?? 0) };
}

/**
 * The first `count` rows of a table, page by page from offset 0, following
 * next_offset (each page at most MAX_ROWS_PAGE). `fetchPage` is the GET
 * /api/data/tables/[id] call.
 */
export async function collectRows(fetchPage: (offset: number, limit: number) => Promise<Pick<TableResponse, "rows" | "next_offset" | "table">>, count: number) {
  const rows: DataRow[] = [];
  let offset: number | null = 0;
  let table: DataTableSummary | null = null;
  while (offset !== null && rows.length < count) {
    const page: Pick<TableResponse, "rows" | "next_offset" | "table"> = await fetchPage(offset, Math.min(MAX_ROWS_PAGE, count - rows.length));
    table = page.table;
    rows.push(...page.rows);
    if (!page.rows.length) break;
    offset = page.next_offset;
  }
  return { table, rows: rows.slice(0, count) };
}

// --- Rows and tables in the pane's state ------------------------------------------

/** Append a page to the rows already shown (by idx, so a repeated page doesn't duplicate). */
export function appendRows(existing: DataRow[], page: DataRow[]): DataRow[] {
  const seen = new Set(existing.map((r) => r.idx));
  return [...existing, ...page.filter((r) => !seen.has(r.idx))].sort((a, b) => a.idx - b.idx);
}

/** Replace one row by idx (an override or revert's reply). */
export const replaceRow = (rows: DataRow[], row: DataRow) => rows.map((r) => (r.idx === row.idx ? row : r));

/** Merge a PATCH reply's table into a linked table (keeping the link's own fields). */
export function mergeTable<T extends DataTableSummary>(list: T[], table: DataTableSummary): T[] {
  return list.map((t) => (t.id === table.id ? { ...t, ...table } : t));
}

/** The effective value of a cell, and its override if a person changed it. */
export function cellAt(row: DataRow, col: Pick<DataColumn, "key">, index: number) {
  return { value: row.cells[index] ?? null, override: row.overrides?.[col.key] ?? null };
}

/**
 * The override request for a cell edit, or null when nothing changes. An empty
 * input means an empty cell; text equal to the source value is a revert.
 */
export function cellEdit(row: DataRow, col: Pick<DataColumn, "key">, index: number, input: string): { op: "override"; row: number; key: string; value: string | null } | { op: "revert"; row: number; key: string } | null {
  const { value, override } = cellAt(row, col, index);
  const next = input.trim() === "" ? null : input;
  if ((next ?? "") === (value ?? "")) return null;
  if (override && (next ?? "") === (override.original ?? "")) return { op: "revert", row: row.idx, key: col.key };
  return { op: "override", row: row.idx, key: col.key, value: next };
}

// --- Add-table picker ---------------------------------------------------------------

export type PickerRow = { table: DataTableSummary; linked: boolean };
export type PickerGroups = { fromDocument: PickerRow[]; library: PickerRow[] };

/**
 * The picker's two groups: tables from the document's sources, then library
 * search results not already in the first group. Tables already linked to the
 * document are kept and say "Linked".
 */
export function pickerGroups(forDocument: DataTableSummary[], library: DataTableSummary[], linkedIds: Iterable<string>): PickerGroups {
  const linked = new Set(linkedIds);
  const first = new Set(forDocument.map((t) => t.id));
  const row = (table: DataTableSummary): PickerRow => ({ table, linked: linked.has(table.id) });
  return { fromDocument: forDocument.map(row), library: library.filter((t) => !first.has(t.id)).map(row) };
}

/** Whether a table matches the picker's search, for filtering the first group as the person types. */
export function matchesQuery(t: Pick<DataTableSummary, "name" | "columns" | "source">, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [t.name, t.source.title ?? "", t.source.filename ?? "", ...t.columns.map((c) => c.label)].some((s) => s.toLowerCase().includes(needle));
}

// --- Mark as replaced by --------------------------------------------------------

/**
 * Tables `t` can be marked as replaced by: the other active tables of the same
 * source first, then the other active tables linked to the document. Never
 * itself, and never one whose own replacement chain leads back to it.
 */
export function replacementCandidates(t: DataTableSummary, sameSource: DataTableSummary[], linked: DataTableSummary[]): DataTableSummary[] {
  const byId = new Map([...sameSource, ...linked].map((x) => [x.id, x]));
  const leadsBack = (x: DataTableSummary) => {
    const seen = new Set<string>();
    let next: string | null = x.superseded_by;
    while (next && !seen.has(next)) {
      if (next === t.id) return true;
      seen.add(next);
      next = byId.get(next)?.superseded_by ?? null;
    }
    return false;
  };
  const out: DataTableSummary[] = [];
  const seen = new Set<string>([t.id]);
  for (const x of [...sameSource.filter((s) => s.source_id === t.source_id), ...linked]) {
    if (seen.has(x.id) || x.status !== "active" || leadsBack(x)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

// --- Prefill (Suggestions → Data) -------------------------------------------------

/**
 * The PATCH that marks the prefill's suggestion added once `tableId` is linked,
 * or null when there is no prefill.
 */
export function prefillCompletion(prefill: DataPrefill | null, tableId: string): { suggestionId: string; body: SuggestionActionRequest } | null {
  if (!prefill) return null;
  return { suggestionId: prefill.suggestionId, body: { action: "add", data_table_id: tableId } };
}

// --- Sources -------------------------------------------------------------------------

const TABLE_MIMES = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Whether a source can have tables at all (the library hides the Tables section otherwise). */
export function canHaveTables(s: { kind: string; mime: string | null; filename?: string | null }): boolean {
  if (s.kind !== "file") return false;
  if (s.mime && TABLE_MIMES.has(s.mime.split(";")[0].trim().toLowerCase())) return true;
  return /\.(csv|xlsx|pdf|png|jpe?g|webp)$/i.test(s.filename ?? "");
}

/** Linked tables counted by source id (the Sources tab's "N tables"). */
export function countBySource(tables: Array<Pick<DataTableSummary, "source_id">>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tables) out.set(t.source_id, (out.get(t.source_id) ?? 0) + 1);
  return out;
}

/** "Reading 2 sources…", or null when none is busy. */
export const readingText = (busy: number) => (busy > 0 ? `Reading ${plural(busy, "source")}…` : null);

/** "3 tables". */
export const tablesText = (n: number) => plural(n, "table");
