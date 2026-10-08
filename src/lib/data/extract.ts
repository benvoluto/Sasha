// The table pass of source ingest (phase5-spec.md §3.1): a file's bytes → the
// tables to store. CSV and XLSX are read in process; PDFs and images go to
// Gemini. Each returns a TableExtractionOutcome: `ok: false` keeps the source's
// earlier tables, `ok: true` (even with none) replaces them.

import { MAX_TABLES_PER_SOURCE, type ExtractedTable, type RawGrid, type TableExtractionOutcome } from "./contract";
import { buildTable } from "./build";
import { parseCsv } from "./csv";
import { readGeminiTables } from "./gemini-tables";
import { readXlsx, SpreadsheetError } from "./xlsx";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_MIME = "text/csv";
/** File types the Gemini table pass reads. */
export const GEMINI_TABLE_MIMES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

export const TOO_MANY_TABLES = `This file has more than ${MAX_TABLES_PER_SOURCE} tables; only the first ${MAX_TABLES_PER_SOURCE} were kept.`;

/** Build each grid into a table (dropping ones too small to be tables), at most MAX_TABLES_PER_SOURCE. */
export function tablesFromGrids(grids: RawGrid[]): { tables: ExtractedTable[]; warnings: string[] } {
  const tables: ExtractedTable[] = [];
  for (const grid of grids) {
    const t = buildTable(grid, { index: tables.length });
    if (t) tables.push(t);
  }
  if (tables.length > MAX_TABLES_PER_SOURCE) return { tables: tables.slice(0, MAX_TABLES_PER_SOURCE), warnings: [TOO_MANY_TABLES] };
  return { tables, warnings: [] };
}

/**
 * The tables of a CSV (one) or an XLSX (one per sheet). An XLSX that can't be
 * opened is `ok: false` with a message for the person.
 */
export async function extractSpreadsheetTables(bytes: Uint8Array, file: { name: string; mime: string }): Promise<TableExtractionOutcome> {
  try {
    if (file.mime === XLSX_MIME) {
      const { grids, warnings } = readXlsx(bytes);
      const built = tablesFromGrids(grids);
      return { ok: true, tables: built.tables, warnings: [...warnings, ...built.warnings] };
    }
    const grid = parseCsv(bytes, file.name);
    return { ok: true, ...tablesFromGrids(grid ? [grid] : []) };
  } catch (error) {
    if (error instanceof SpreadsheetError) return { ok: false, reason: error.message };
    console.error(`[DataExtract] reading tables from ${file.name} failed:`, error);
    return { ok: false, reason: "The table in this file couldn't be read." };
  }
}

/** The tables Gemini finds in a PDF or image. Never throws. */
export async function extractGeminiTables(bytes: Buffer, file: { name: string; mime: string }, opts: { deadline?: number } = {}): Promise<TableExtractionOutcome> {
  try {
    const read = await readGeminiTables(bytes, file, opts);
    if (!read.ok) return read;
    if (read.dropped.length) console.log(`[DataExtract] ${file.name}: dropped ${read.dropped.map((d) => `"${d.title}" p.${d.page} (${d.reason})`).join(", ")}`);
    const built = tablesFromGrids(read.grids);
    return { ok: true, tables: built.tables, warnings: [...read.warnings, ...built.warnings], unread: read.unread };
  } catch (error) {
    console.error(`[DataExtract] Gemini tables for ${file.name} failed:`, error);
    return { ok: false, reason: "Tables in this file couldn't be read. Read it again to try." };
  }
}
