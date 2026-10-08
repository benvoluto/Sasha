// One grid (a CSV file, a sheet, a table Gemini read) → one finished table
// (phase5-spec.md §3.5): header found, columns typed, limits applied, and
// what was cut said in notes. Pure.

import { columnKey, MAX_CELL_CHARS, MAX_LABEL_CHARS, MAX_TABLE_COLS, MAX_TABLE_ROWS, storableText, type Cell, type DataColumn, type ExtractedTable, type RawGrid } from "./contract";
import { detectHeader, inferColumn } from "./infer";

/** A cell cut to MAX_CELL_CHARS, ending "…" when cut (never between the halves of a surrogate pair). */
export function cutCell(s: string, max = MAX_CELL_CHARS): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head}…`;
}

/** A sheet called "Sheet1" says nothing; its title row (if any) names the table better. */
const GENERIC_NAME = /^Sheet\d*$/i;

export type BuildOptions = {
  /** Position among the source's tables (0-based), for the "Table N" fallback name. */
  index?: number;
};

/** The finished table, or null when it has fewer than 2 columns or no data rows. */
export function buildTable(grid: RawGrid, opts: BuildOptions = {}): ExtractedTable | null {
  // Every method's text passes here on its way to Postgres.
  const notes = (grid.notes ?? []).map(storableText);
  let truncated = grid.truncated;

  let cells = grid.cells.map((r) => r.map(storableText));
  let width = 0;
  for (const r of cells) width = Math.max(width, r.length);
  if (width > MAX_TABLE_COLS) {
    cells = cells.map((r) => r.slice(0, MAX_TABLE_COLS));
    truncated = true;
    notes.push(`Only the first ${MAX_TABLE_COLS} columns were kept.`);
  }

  const header = detectHeader(cells, grid.header_rows);
  let body = header.rows.slice(header.header_rows);
  if (header.labels.length < 2 || !body.length) return null;
  if (body.length > MAX_TABLE_ROWS) {
    body = body.slice(0, MAX_TABLE_ROWS);
    truncated = true;
    notes.push(`Only the first ${MAX_TABLE_ROWS.toLocaleString("en-US")} rows were kept.`);
  }

  let cut = false;
  const rows: Cell[][] = body.map((r) =>
    r.map((c) => {
      if (!c) return null;
      if (c.length > MAX_CELL_CHARS) cut = true;
      return cutCell(c);
    }),
  );
  if (cut) notes.push(`Some long cells were cut to ${MAX_CELL_CHARS.toLocaleString("en-US")} characters.`);

  const columns: DataColumn[] = header.labels.map((label, i) => {
    const guess = inferColumn(rows.map((r) => r[i]));
    return { key: columnKey(i), label, type: guess.type, inferred: guess.type, unit: guess.unit };
  });

  const given = storableText(grid.name).trim();
  const name = (!given || (GENERIC_NAME.test(given) && header.title) ? (header.title ?? "") : given) || `Table ${(opts.index ?? 0) + 1}`;

  return {
    match_key: storableText(grid.match_key),
    name: cutCell(name, MAX_LABEL_CHARS),
    columns,
    rows,
    extraction_method: grid.method,
    sheet: grid.sheet == null ? null : storableText(grid.sheet),
    page: grid.page ?? null,
    page_end: grid.page_end ?? null,
    confidence: grid.confidence ?? null,
    notes: notes.join(" "),
    truncated,
  };
}
