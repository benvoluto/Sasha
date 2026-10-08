// Shapes for Phase 5 data (PLAN decision 6, §4.3, §6.6): tables read from a
// source's spreadsheets and PDFs, linked to documents and inserted into them
// as snapshots. Client-safe (zod, types and pure helpers only).
//
// CONTRACT (Phase 5): see phase5-spec.md. Shared by the extraction, data-api
// and data-ui tracks. Change a shape only with every consumer updated in the
// same change.

import { z } from "zod";

// --- Limits ---------------------------------------------------------------------

/** Rows kept per table; the rest are dropped and the table is marked truncated. */
export const MAX_TABLE_ROWS = 5000;
/** Columns kept per table; wider tables keep the first ones and say so in notes. */
export const MAX_TABLE_COLS = 100;
/** Characters kept per cell (longer text is cut with an ellipsis). */
export const MAX_CELL_CHARS = 1000;
/** Header and table names. */
export const MAX_LABEL_CHARS = 200;
/** Tables kept from one source (sheets, or tables found in a PDF). */
export const MAX_TABLES_PER_SOURCE = 50;
/** Rows a page of GET /api/data/tables/[id] returns at most. */
export const MAX_ROWS_PAGE = 500;
export const DEFAULT_ROWS_PAGE = 100;
/** The row counts "Insert table" offers; never more than the last. */
export const INSERT_ROW_OPTIONS = [10, 25, 50, 100, 200] as const;
export const MAX_INSERT_ROWS = INSERT_ROW_OPTIONS[INSERT_ROW_OPTIONS.length - 1];
export const DEFAULT_INSERT_ROWS = 25;

// --- Text safety ------------------------------------------------------------------

/** A UTF-16 surrogate half with no partner: invalid in Postgres TEXT and JSONB. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text Postgres can store: NUL dropped (TEXT rejects 0x00, JSONB the \u0000
 * escape) and lone surrogates replaced with U+FFFD. SheetJS unescapes
 * _x0000_ and &#0; in a workbook, and a model reply can hold either.
 */
export function storableText(s: string): string {
  return s.replace(/\u0000/g, "").replace(LONE_SURROGATE, "\uFFFD");
}

// --- Tables ---------------------------------------------------------------------

export const COLUMN_TYPES = ["number", "currency", "percent", "date", "text"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const ColumnType = z.enum(COLUMN_TYPES);

export const TABLE_STATUSES = ["active", "superseded", "hidden"] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const EXTRACTION_METHODS = ["csv", "xlsx", "gemini-pdf", "gemini-image"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** Column keys are positional and stable for the table's life: c1, c2, … */
export const COLUMN_KEY_RE = /^c[1-9]\d{0,2}$/;
export const columnKey = (index: number) => `c${index + 1}`;

export const DataColumn = z.strictObject({
  key: z.string().regex(COLUMN_KEY_RE),
  /** The header text (or "Column N" when the table had none). */
  label: z.string().max(MAX_LABEL_CHARS),
  /** The type in use: the inferred one, or the person's choice. */
  type: ColumnType,
  /** What inference chose, so a person's type can be reverted. */
  inferred: ColumnType,
  /** A currency symbol or code ("$", "€", "USD") or "%"; null when none. */
  unit: z.string().max(12).nullable(),
});
export type DataColumn = z.infer<typeof DataColumn>;

/** One cell as the file showed it (display text, trimmed); null when empty. */
export type Cell = string | null;

/** A cell a person changed: what the source said, and who changed it when. */
export type CellOverride = { original: Cell; by: string; at: string };

export type DataRow = {
  /** 0-based position in the table (header rows excluded). */
  idx: number;
  /** Aligned with the table's columns; overrides already applied. */
  cells: Cell[];
  /** Overridden cells by column key; absent when none. */
  overrides?: Record<string, CellOverride>;
};

/** Where a table came from, for display ("Budget.xlsx · Sheet 2", "Report.pdf · p. 4"). */
export type DataTableSource = { id: string; title: string | null; filename: string | null; kind: "file" | "url" | "note"; mime: string | null };

export type DataTableSummary = {
  id: string;
  source_id: string;
  source: DataTableSource;
  name: string;
  columns: DataColumn[];
  row_count: number;
  status: TableStatus;
  /** The table that replaced this one (a person's supersede, or a re-read); null otherwise. */
  superseded_by: string | null;
  extraction_method: ExtractionMethod;
  /** The XLSX sheet name, or null. */
  sheet: string | null;
  /** First and last PDF page the table spans (1-based), or null. */
  page: number | null;
  page_end: number | null;
  /** The model's confidence for a Gemini table (0–1); null for CSV/XLSX. */
  confidence: number | null;
  /** What extraction noticed (rows dropped, merged headers, unreadable cells…). */
  notes: string;
  /** Rows or columns beyond the limits were dropped. */
  truncated: boolean;
  override_count: number;
  /** Documents this table is linked to. */
  document_ids: string[];
  created_at: string;
  updated_at: string;
};

export type LinkedDataTable = DataTableSummary & { added_by: string; added_at: string };

// --- Extraction (extraction track → data store) ---------------------------------

/**
 * A rectangular grid of display strings before header detection: one CSV
 * file, one sheet, or one table Gemini returned. Rows may be ragged; the
 * builder pads them.
 */
export type RawGrid = {
  /** Sheet name, or a title Gemini gave; used for the table name. */
  name: string;
  /** Identifies the same table across re-reads: "csv", "sheet:<name>", "page:<n>#<k>". */
  match_key: string;
  cells: string[][];
  /** Rows or columns were cut while reading. */
  truncated: boolean;
  method: ExtractionMethod;
  sheet?: string | null;
  page?: number | null;
  page_end?: number | null;
  confidence?: number | null;
  notes?: string[];
  /** Header rows already known (Gemini gives its header separately); undefined → detect. */
  header_rows?: number;
};

/** Header detection's result for a grid. */
export type HeaderGuess = {
  /** How many leading rows are header (0, 1 or more for multi-row headers). */
  header_rows: number;
  /** One label per column; multi-row headers joined with " · "; blanks become "Column N". */
  labels: string[];
};

/** Type inference's result for one column's values. */
export type ColumnGuess = { type: ColumnType; unit: string | null };

/** A finished table, ready for replaceSourceTables. */
export type ExtractedTable = {
  match_key: string;
  name: string;
  columns: DataColumn[];
  rows: Cell[][];
  extraction_method: ExtractionMethod;
  sheet: string | null;
  page: number | null;
  page_end: number | null;
  confidence: number | null;
  notes: string;
  truncated: boolean;
};

/**
 * What a table pass produced. `ok: false` means the pass failed (the source's
 * earlier tables are kept); `ok: true` with no tables means the file has none
 * (earlier tables are superseded).
 */
/** Pages first..last of a file; last null means to the end of the file. */
export type PageRange = { first: number; last: number | null };

export type TableExtractionOutcome =
  /** `unread`: pages a partly failed pass couldn't read; their earlier tables are kept. */
  | { ok: true; tables: ExtractedTable[]; warnings: string[]; unread?: PageRange[] }
  | { ok: false; reason: string };

// --- Routes -----------------------------------------------------------------------

const uuid = z.string().uuid();

/**
 * GET /api/data/tables?source_id=&document_id=&for_document=&status=active,hidden&q=
 * Filters combine (AND). Newest first, at most 200.
 */
export const TableListQuery = z.strictObject({
  /** Tables read from this source. */
  source_id: uuid.optional(),
  /** Tables linked to this document. */
  document_id: uuid.optional(),
  /** Tables read from sources linked to this document (the Data tab's picker). */
  for_document: uuid.optional(),
  /** Comma-separated statuses; default "active". */
  status: z
    .string()
    .optional()
    .transform((s, ctx) => {
      const list = (s ?? "active").split(",").map((x) => x.trim()).filter(Boolean);
      if (!list.length || list.some((x) => !(TABLE_STATUSES as readonly string[]).includes(x))) {
        ctx.addIssue({ code: "custom", message: "Unknown status." });
        return z.NEVER;
      }
      return [...new Set(list)] as TableStatus[];
    }),
  q: z.string().trim().max(200).optional(),
});
export type TableListQuery = z.infer<typeof TableListQuery>;
export type TableListResponse = { tables: DataTableSummary[] };

/** GET /api/data/tables/[id]?offset=&limit= */
export const TableRowsQuery = z.strictObject({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_ROWS_PAGE).default(DEFAULT_ROWS_PAGE),
});
export type TableRowsQuery = z.infer<typeof TableRowsQuery>;
export type TableResponse = {
  table: DataTableSummary;
  rows: DataRow[];
  offset: number;
  /** The offset of the next page, or null at the end. */
  next_offset: number | null;
};

const cellValue = z.string().overwrite(storableText).max(MAX_CELL_CHARS).nullable();
const labelText = z.string().overwrite(storableText).trim().min(1).max(MAX_LABEL_CHARS);

/** PATCH /api/data/tables/[id] — one change per request. */
export const DataTablePatch = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("rename"), name: labelText }),
  z.strictObject({
    op: z.literal("column"),
    key: z.string().regex(COLUMN_KEY_RE),
    label: labelText.optional(),
    /** null reverts to the inferred type. */
    type: ColumnType.nullable().optional(),
  }),
  z.strictObject({ op: z.literal("hide") }),
  z.strictObject({ op: z.literal("unhide") }),
  /** Mark this table replaced by another table of the team (not itself, not superseded). */
  z.strictObject({ op: z.literal("supersede"), by: uuid }),
  /** Undo a person's supersede (status back to active). */
  z.strictObject({ op: z.literal("restore") }),
  z.strictObject({ op: z.literal("override"), row: z.number().int().min(0), key: z.string().regex(COLUMN_KEY_RE), value: cellValue }),
  z.strictObject({ op: z.literal("revert"), row: z.number().int().min(0), key: z.string().regex(COLUMN_KEY_RE) }),
]);
export type DataTablePatch = z.infer<typeof DataTablePatch>;
/** → 200; `row` is the changed row for override/revert. */
export type TablePatchResponse = { table: DataTableSummary; row?: DataRow };

/** GET /api/documents/[id]/data */
export type DocumentDataResponse = { tables: LinkedDataTable[] };

/** POST /api/documents/[id]/data — link a table of the team to the document (idempotent). */
export const DataLinkRequest = z.strictObject({ table_id: uuid });
export type DataLinkRequest = z.infer<typeof DataLinkRequest>;
// → 200 { table: LinkedDataTable }. DELETE /api/documents/[id]/data/[tableId] → 200 { ok: true }.

/** GET /api/data/tables/[id]/csv → text/csv attachment (formula-safe, overrides applied). */

// --- Editor snapshot ------------------------------------------------------------

/** The attribute a TipTap table node carries to point back at its data_table. */
export const DATA_TABLE_ATTR = "data-table-id";

/** The library address a snapshot's citation line links to. */
export const tableCitationHref = (sourceId: string, tableId: string) =>
  `/library?source=${encodeURIComponent(sourceId)}&table=${encodeURIComponent(tableId)}`;

/** "Insert table" in the Data tab → document-screen inserts this at the cursor. */
export type TableSnapshot = { table: DataTableSummary; rows: DataRow[] };

// --- Formula safety ---------------------------------------------------------------

const PLAIN_NUMBER = /^[+-]?(\d[\d,]*)?(\.\d+)?%?$/;

/**
 * A cell made safe to open in a spreadsheet (CSV injection): text beginning
 * with = + - @ tab or CR gets a leading apostrophe, unless it is a plain
 * number such as "-12.5" or "+3%". Applied to CSV downloads and to snapshot
 * cells inserted into a document (which export later).
 */
export function neutralizeFormula(cell: Cell): string {
  const s = cell ?? "";
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  if (/\d/.test(s) && PLAIN_NUMBER.test(s)) return s;
  return `'${s}`;
}

/** One CSV field: neutralized, then quoted when it holds a comma, semicolon, tab, quote or line break. */
export function csvField(cell: Cell): string {
  const s = neutralizeFormula(cell);
  // ; and tab split fields too where Excel's list separator is one of them,
  // which would let "a;=1+1" open as a formula cell.
  return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole CSV document (header line, then rows), CRLF line ends as RFC 4180 has them. */
export function toCsv(columns: Pick<DataColumn, "label">[], rows: Cell[][]): string {
  const lines = [columns.map((c) => csvField(c.label)), ...rows.map((r) => columns.map((_, i) => csvField(r[i] ?? null)))];
  return lines.map((l) => l.join(",")).join("\r\n") + "\r\n";
}

// --- Display ----------------------------------------------------------------------

/** Where a table sits in its source: "Sheet: Budget", "p. 4", "pp. 4–5", or "". */
export function tableLocation(t: Pick<DataTableSummary, "sheet" | "page" | "page_end">): string {
  if (t.sheet) return `Sheet: ${t.sheet}`;
  if (t.page && t.page_end && t.page_end !== t.page) return `pp. ${t.page}–${t.page_end}`;
  if (t.page) return `p. ${t.page}`;
  return "";
}

/** Typed columns line up on the right; text and dates on the left. */
export const isNumericType = (t: ColumnType) => t === "number" || t === "currency" || t === "percent";
