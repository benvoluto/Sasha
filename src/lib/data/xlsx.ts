// An .xlsx file's bytes → one grid per sheet (phase5-spec.md §3.2). The zip is
// checked first (zip-guard.ts), then SheetJS reads cached cell values only:
// formulas are never evaluated and macros never loaded, so a workbook can't
// make the server compute or fetch anything.

import * as XLSX from "xlsx";
import { MAX_TABLE_COLS, MAX_TABLE_ROWS, storableText, type RawGrid } from "./contract";
import { checkXlsxZip } from "./zip-guard";

/** A spreadsheet that can't be read at all; the message is for the person. */
export class SpreadsheetError extends Error {}

const READ_OPTIONS: XLSX.ParsingOptions = {
  type: "buffer",
  dense: true,
  cellFormula: false,
  cellHTML: false,
  cellStyles: false,
  // The number format tells a date from a date-time, a time of day or a duration.
  cellNF: true,
  cellDates: true,
  bookVBA: false,
  bookFiles: false,
  sheetRows: MAX_TABLE_ROWS + 10,
  WTF: false,
};

/** Rows from the top (after leading blanks) whose merged cells are filled before header detection. */
const HEADER_ZONE_ROWS = 4;
/** A sheet may list any number of merges; only this many in the header zone are filled. */
const MAX_HEADER_MERGES = 1000;

const pad = (n: number) => String(n).padStart(2, "0");
/** SheetJS reads a date serial as that day at UTC midnight, whatever the server's time zone. */
const dateText = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const timeText = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ""}`;

/**
 * A date cell as text: yyyy-mm-dd, yyyy-mm-dd hh:mm[:ss] when it has a time, or
 * hh:mm[:ss] for a time of day (a serial under one day, which SheetJS dates
 * to 31 December 1899). A duration format ([h]:mm) keeps Excel's own text.
 */
function dateCellText(cell: XLSX.CellObject, value: Date): string {
  if (Number.isNaN(value.getTime())) return "";
  // Serials are fractions of a day; round away float noise to the second.
  const d = new Date(Math.round(value.getTime() / 1000) * 1000);
  const format = typeof cell.z === "string" ? cell.z.replace(/"[^"]*"/g, "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "") : null;
  if (format && /\[[hms]+\]/i.test(format) && cell.w !== undefined) return cell.w;
  const hasTime = format ? /[hs]|am\/pm|a\/p/i.test(format) : d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() > 0;
  const hasDate = format ? /[yd]/i.test(format) || !hasTime : d.getUTCFullYear() >= 1900;
  if (hasTime && (!hasDate || d.getUTCFullYear() < 1900)) return timeText(d);
  if (hasTime) return `${dateText(d)} ${timeText(d)}`;
  return dateText(d);
}

function cellText(cell: XLSX.CellObject | undefined): string {
  return storableText(rawCellText(cell));
}

function rawCellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.t === "z") return "";
  if (cell.v instanceof Date) return dateCellText(cell, cell.v);
  if (cell.w !== undefined) return cell.w;
  return cell.v === undefined || cell.v === null ? "" : String(cell.v);
}

/** Fill merged ranges in the first rows with their top-left value, except a lone title. */
function fillHeaderMerges(cells: string[][], merges: XLSX.Range[], origin: { r: number; c: number }) {
  const first = cells.findIndex((r) => r.some((c) => c.trim()));
  if (first < 0) return;
  // The fill never leaves the header zone, so each merge costs at most
  // HEADER_ZONE_ROWS x MAX_TABLE_COLS cells however far it claims to reach.
  const lastRow = Math.min(first + HEADER_ZONE_ROWS - 1, cells.length - 1);
  let considered = 0;
  for (const m of merges) {
    const r0 = m.s.r - origin.r;
    const c0 = m.s.c - origin.c;
    if (r0 < first || r0 > lastRow || c0 < 0) continue;
    if (++considered > MAX_HEADER_MERGES) break;
    const value = cells[r0][c0] ?? "";
    if (!value.trim()) continue;
    // A title merged across the top is the row's only value: leave it for title detection.
    if (cells[r0].filter((c) => c.trim()).length === 1) continue;
    for (let r = r0; r <= Math.min(m.e.r - origin.r, lastRow); r++) {
      for (let c = c0; c <= Math.min(m.e.c - origin.c, cells[r].length - 1); c++) {
        if (!cells[r][c]?.trim()) cells[r][c] = value;
      }
    }
  }
}

/**
 * One grid per sheet with cells, in workbook order. Chartsheets and empty
 * sheets are skipped. Throws SpreadsheetError when the file can't be read.
 */
export function readXlsx(bytes: Uint8Array): { grids: RawGrid[]; warnings: string[] } {
  const guard = checkXlsxZip(bytes);
  if (!guard.ok) throw new SpreadsheetError(guard.message);

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), READ_OPTIONS);
  } catch (error) {
    console.warn("[xlsx] could not read the workbook:", error instanceof Error ? error.message : error);
    throw new SpreadsheetError("This spreadsheet couldn't be read. Check that it opens, then upload it again.");
  }

  const grids: RawGrid[] = [];
  const warnings: string[] = [];
  wb.SheetNames.forEach((sheetName, i) => {
    const sheet = wb.Sheets[sheetName] as (XLSX.WorkSheet & { "!type"?: string }) | undefined;
    if (!sheet || (sheet["!type"] && sheet["!type"] !== "sheet")) return;
    const ref = sheet["!ref"];
    if (!ref) return;
    const range = XLSX.utils.decode_range(ref);
    const notes: string[] = [];
    let truncated = false;
    // A sheet can claim A1:XFD1048576; never walk more columns than are kept.
    if (range.e.c - range.s.c + 1 > MAX_TABLE_COLS) {
      range.e.c = range.s.c + MAX_TABLE_COLS - 1;
      truncated = true;
      notes.push(`Only the first ${MAX_TABLE_COLS} columns were kept.`);
    }
    range.e.r = Math.min(range.e.r, range.s.r + MAX_TABLE_ROWS + 10);

    const data = (sheet["!data"] ?? []) as XLSX.CellObject[][];
    const cells: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = data[r];
      const out: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) out.push(cellText(row?.[c]));
      cells.push(out);
    }
    if (!cells.some((r) => r.some((c) => c.trim()))) return;
    fillHeaderMerges(cells, sheet["!merges"] ?? [], range.s);

    if (wb.Workbook?.Sheets?.[i]?.Hidden) notes.push("Hidden sheet in the file.");
    // Sheet names are unescaped like cells, so they can hold a NUL too.
    const name = storableText(sheetName);
    grids.push({ name, match_key: `sheet:${name}`, cells, truncated, method: "xlsx", sheet: name, notes });
  });
  return { grids, warnings };
}
