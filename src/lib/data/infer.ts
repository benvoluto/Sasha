// Reading a table's cells as numbers, money, percentages and dates, and
// deciding which leading rows are its header (phase5-spec.md §3.3–3.4).
// Pure: no I/O, so CSV, XLSX and Gemini grids all go through the same rules.
//
// Cells stay stored as the display strings the file showed; this module is
// what turns them into typed values when a column is read (parseCell) and what
// chooses each column's type when a table is first built (inferColumn).

import { MAX_LABEL_CHARS, type ColumnGuess, type ColumnType, type HeaderGuess } from "./contract";

// --- Placeholders -----------------------------------------------------------------

const PLACEHOLDERS = new Set(["", "-", "–", "—", "n/a", "na", "..", "*", "?"]);

/** Empty, or a stand-in for "no value" ("-", "n/a", "..") that inference ignores. */
export const isPlaceholder = (raw: string | null | undefined) => PLACEHOLDERS.has((raw ?? "").trim().toLowerCase());

// --- Numbers ----------------------------------------------------------------------

const CURRENCY_SYMBOL = String.raw`R\$|CHF|[$€£¥₹₩₽₺]`;
const ISO_CODE = "USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|INR|CNY";
const PREFIX_SYMBOL = new RegExp(`^(${CURRENCY_SYMBOL})\\s?(.+)$`);
const SUFFIX_SYMBOL = new RegExp(`^(.+?)\\s?(${CURRENCY_SYMBOL})$`);
const PREFIX_ISO = new RegExp(`^(${ISO_CODE})\\s+(.+)$`, "i");
const SUFFIX_ISO = new RegExp(`^(.+?)\\s+(${ISO_CODE})$`, "i");

const US_COMMAS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const SPACED = /^\d{1,3}( \d{3})+(\.\d+)?$/;
const PLAIN = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const EU_DOTS = /^\d{1,3}(\.\d{3})+(,\d+)?$/;
const EU_COMMA = /^\d+,\d+$/;

type NumericKind = "number" | "currency" | "percent";
/** A number with its markers taken off: the bare digits, sign and what it was. */
type NumericParts = { core: string; negative: boolean; kind: NumericKind; unit: string | null };

const SIGN = /^([+\-−])\s*(.+)$/;

/** Split "($1,234)", "-12.5 %", "1 234 EUR", "1234-" into digits, sign and marker; null when it isn't numeric-looking. */
function numericParts(raw: string): NumericParts | null {
  let s = raw.trim().replace(/[   ]/g, " ");
  if (!s || !/\d/.test(s)) return null;
  let negative = false;
  const paren = /^\((.+)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }
  const takeSign = () => {
    const m = SIGN.exec(s);
    if (m) {
      if (m[1] !== "+") negative = !negative;
      s = m[2].trim();
    }
  };
  takeSign();
  let kind: NumericKind = "number";
  let unit: string | null = null;
  if (s.endsWith("%")) {
    kind = "percent";
    unit = "%";
    s = s.slice(0, -1).trim();
  } else {
    const m = PREFIX_SYMBOL.exec(s) ?? PREFIX_ISO.exec(s);
    const n = m ? null : (SUFFIX_SYMBOL.exec(s) ?? SUFFIX_ISO.exec(s));
    if (m) {
      kind = "currency";
      unit = m[1].toUpperCase();
      s = m[2].trim();
    } else if (n) {
      kind = "currency";
      unit = n[2].toUpperCase();
      s = n[1].trim();
    }
  }
  takeSign();
  if (s.endsWith("-") && s.length > 1) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (!/^[\d.,  ]+$/.test(s) || !/\d/.test(s)) return null;
  return { core: s, negative, kind, unit };
}

/** True when the digits are in the European style: 1.234.567,89 or 12,5. */
const isEuropeanCore = (core: string) => EU_DOTS.test(core) || EU_COMMA.test(core);

function coreValue(core: string, european: boolean): number | null {
  let digits: string | null = null;
  if (european && isEuropeanCore(core)) digits = core.replace(/\./g, "").replace(",", ".");
  else if (US_COMMAS.test(core)) digits = core.replace(/,/g, "");
  else if (SPACED.test(core)) digits = core.replace(/ /g, "");
  else if (PLAIN.test(core)) digits = core;
  else if (!european && /,/.test(core) && isEuropeanCore(core) && !US_COMMAS.test(core)) {
    // Unambiguously European without column context ("1.234,5", "12,5").
    digits = core.replace(/\./g, "").replace(",", ".");
  }
  if (digits === null) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function numericValue(raw: string, european = false): { value: number; kind: NumericKind; unit: string | null } | null {
  const parts = numericParts(raw);
  if (!parts) return null;
  const v = coreValue(parts.core, european);
  if (v === null) return null;
  return { value: parts.negative ? -v || 0 : v, kind: parts.kind, unit: parts.unit };
}

/**
 * A plain number as written ("1,234.5", "(1,234)", "−3", "1 234", "1234-"),
 * or null. Currency and percent markers are not plain numbers; parseCell reads
 * those. `european` reads dot thousands with a comma decimal.
 */
export function parseNumber(raw: string, european = false): number | null {
  const n = numericValue(raw, european);
  return n && n.kind === "number" ? n.value : null;
}

// --- Dates ------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const YMD_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const YEAR_MONTH = /^(\d{4})-(\d{1,2})$/;
const DAY_MONTH_YEAR = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{2}|\\d{4})$`, "i");
const MONTH_DAY_YEAR = new RegExp(`^${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{2}|\\d{4})$`, "i");
const MONTH_YEAR = new RegExp(`^${MONTH},?\\s+(\\d{4})$`, "i");

const fullYear = (y: string) => (y.length === 2 ? (Number(y) < 50 ? 2000 : 1900) + Number(y) : Number(y));
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 9999) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** The first part of an m/d/yyyy or d/m/yyyy date, when the cell is one. */
function slashedFirst(raw: string): number | null {
  const m = SLASHED.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * A date as ISO yyyy-mm-dd, or null. `dayFirst` reads 03/04/2024 as 3 April;
 * a first part over 12 is read day-first regardless. A bare year is not a date.
 */
export function parseDate(raw: string, dayFirst = false): string | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = ISO_DATE.exec(s)) || (m = YMD_SLASH.exec(s))) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = SLASHED.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const df = dayFirst || a > 12;
    return isoDate(fullYear(m[3]), df ? b : a, df ? a : b);
  }
  if ((m = YEAR_MONTH.exec(s))) return isoDate(Number(m[1]), Number(m[2]), 1);
  if ((m = DAY_MONTH_YEAR.exec(s))) return isoDate(fullYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  if ((m = MONTH_DAY_YEAR.exec(s))) return isoDate(fullYear(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
  if ((m = MONTH_YEAR.exec(s))) return isoDate(Number(m[2]), MONTHS[m[1].toLowerCase()], 1);
  return null;
}

// --- Cells and columns -----------------------------------------------------------

/** What one cell looks like on its own. */
export function cellKind(raw: string, opts: { european?: boolean; dayFirst?: boolean } = {}): ColumnType {
  const n = numericValue(raw, opts.european);
  if (n) return n.kind;
  if (parseDate(raw, opts.dayFirst)) return "date";
  return "text";
}

/** Column-level reading choices that a single cell can't decide. */
export type ColumnReading = ColumnGuess & {
  /** Dot thousands, comma decimal (every value is written 1.234,5 or 12,5). */
  european: boolean;
  /** Slashed dates are d/m (some first part is over 12). */
  dayFirst: boolean;
};

/**
 * Every value is in the European style, and at least one can only be read
 * that way (a comma, or two dot groups). A column of "1.250" alone stays
 * decimal: that is far more often 1.25 than one thousand two hundred fifty.
 */
function europeanColumn(values: string[]): boolean {
  const cores = values.map((v) => numericParts(v)?.core ?? null);
  if (!cores.length || cores.some((c) => c === null || !isEuropeanCore(c))) return false;
  return cores.some((c) => c!.includes(",") || /\.\d{3}\./.test(c!));
}

const mostCommon = (xs: string[]) => {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** inferColumn with the reading choices it made (European digits, day-first dates). */
export function inferColumnReading(values: Array<string | null | undefined>): ColumnReading {
  const kept = values.map((v) => (v ?? "").trim()).filter((v) => !isPlaceholder(v));
  const dayFirst = kept.some((v) => (slashedFirst(v) ?? 0) > 12);
  const european = europeanColumn(kept);
  const text: ColumnReading = { type: "text", unit: null, european: false, dayFirst };
  if (!kept.length) return text;

  const kinds = kept.map((v) => {
    const n = numericValue(v, european);
    if (n) return { kind: n.kind as ColumnType, unit: n.unit };
    return { kind: (parseDate(v, dayFirst) ? "date" : "text") as ColumnType, unit: null };
  });
  const count = (k: ColumnType) => kinds.filter((x) => x.kind === k).length;
  const n = kept.length;
  const [numbers, money, percents, dates] = [count("number"), count("currency"), count("percent"), count("date")];
  const units = (k: ColumnType) => mostCommon(kinds.filter((x) => x.kind === k && x.unit).map((x) => x.unit!));

  if (money >= 0.5 * n && money + numbers >= 0.8 * n) return { type: "currency", unit: units("currency"), european, dayFirst };
  if (percents >= 0.5 * n && percents + numbers >= 0.8 * n) return { type: "percent", unit: "%", european, dayFirst };
  if (numbers + money + percents >= 0.8 * n && numbers >= money && numbers >= percents) return { type: "number", unit: null, european, dayFirst };
  if (dates >= 0.8 * n) return { type: "date", unit: null, european: false, dayFirst };
  return text;
}

/** The type and unit of a column from its body values (header excluded). */
export function inferColumn(values: Array<string | null | undefined>): ColumnGuess {
  const { type, unit } = inferColumnReading(values);
  return { type, unit };
}

/**
 * A cell's typed value: a number for number, currency and percent columns
 * (a percent as written, so "12%" → 12), an ISO date for date columns, the
 * trimmed text for text. Null when the cell is empty or doesn't read as the
 * column's type. `opts` carries what inferColumnReading decided for the column;
 * without it, only unambiguous European digits ("1.234,5") read that way.
 */
export function parseCell(raw: string | null | undefined, type: ColumnType, opts: { european?: boolean; dayFirst?: boolean } = {}): number | string | null {
  const s = (raw ?? "").trim();
  if (type === "text") return s;
  if (isPlaceholder(s)) return null;
  if (type === "date") return parseDate(s, opts.dayFirst);
  return numericValue(s, opts.european)?.value ?? null;
}

// --- Header detection -------------------------------------------------------------

/** HeaderGuess plus the grid it applies to (trimmed, empty edges and columns dropped, title row removed). */
export type HeaderDetection = HeaderGuess & {
  /** A lone first-row title, taken off the grid; null when none. */
  title: string | null;
  /** The trimmed grid without the title row: header rows first, then the body. */
  rows: string[][];
  /** For each kept column, its index in the input grid. */
  columnMap: number[];
};

const isTyped = (raw: string) => !isPlaceholder(raw) && cellKind(raw) !== "text";
/** A bare year ("2024") in a header row is a label, not a value. */
const isYear = (raw: string) => /^(19|20)\d{2}$/.test(raw.trim());

const empty = (r: string[]) => r.every((c) => !c);

/** Trim every cell, pad ragged rows, and drop fully empty columns (keeping where each kept column was). */
function trimGrid(grid: string[][]): { rows: string[][]; columnMap: number[] } {
  let width = 0;
  for (const r of grid) width = Math.max(width, r.length);
  const rows = grid.map((r) => Array.from({ length: width }, (_, c) => (r[c] ?? "").toString().trim()));
  const columnMap = Array.from({ length: width }, (_, c) => c).filter((c) => rows.some((r) => r[c]));
  return { rows: rows.map((r) => columnMap.map((c) => r[c])), columnMap };
}

/** Trim, drop empty rows at either end and empty columns, and take off a title row. */
export function prepareGrid(grid: string[][]): { rows: string[][]; title: string | null; columnMap: number[] } {
  let start = 0;
  let end = grid.length;
  const blank = (r: string[]) => r.every((c) => !(c ?? "").toString().trim());
  while (start < end && blank(grid[start])) start++;
  while (end > start && blank(grid[end - 1])) end--;
  const trimmed = trimGrid(grid.slice(start, end));
  let rows = trimmed.rows;
  const columnMap = trimmed.columnMap;

  let title: string | null = null;
  if (rows.length > 1 && columnMap.length >= 2 && rows[0].filter(Boolean).length === 1) {
    title = rows[0].find(Boolean)!;
    rows = rows.slice(1);
    while (rows.length && empty(rows[0])) rows.shift();
  }
  return { rows, title, columnMap };
}

const typedShare = (values: string[]) => {
  const kept = values.filter((v) => !isPlaceholder(v));
  return kept.length ? kept.filter((v) => isTyped(v)).length / kept.length : 0;
};

/** Most of a column's values are numbers, currency or percentages (not dates or text). */
const numericShare = (values: string[]) => {
  const kept = values.filter((v) => !isPlaceholder(v));
  return kept.length ? kept.filter((v) => isTyped(v) && cellKind(v) !== "date").length / kept.length : 0;
};

/**
 * A typed cell that still reads as a header label: a bare year, or a date
 * ("Jan 2024", "2024-01", an Excel date cell) over a column of numbers, as in
 * a table of monthly figures.
 */
const labelLike = (cell: string, column: string[]) => isYear(cell) || (cellKind(cell) === "date" && numericShare(column) >= 0.8);

/** Fill blanks after a non-empty cell with it (cells a header spans, as a merged cell would). */
const fillAcross = (row: string[]) => {
  let last = "";
  return row.map((c) => (c ? (last = c) : last));
};

function isHeaderRow0(row: string[], body: string[][]): boolean {
  const filled = row.filter(Boolean);
  if (filled.length < row.length / 2) return false;
  const hasText = filled.some((c) => !isTyped(c));
  // Up to two more all-text header rows may sit between this row and a typed body.
  let skip = 0;
  while (skip < 2 && skip < body.length - 1 && body[skip].every((v, c) => !isTyped(v) || labelLike(v, body.slice(skip + 1).map((r) => r[c])))) skip++;
  const below = (c: number) => body.slice(skip).map((r) => r[c]);
  // A blank corner over a column of row labels ("", 2022, 2023 above
  // "Revenue", "Cost") marks a header as surely as a text cell does.
  const corner = row.some((v, c) => {
    if (v) return false;
    const labels = below(c).filter((x) => x && !isPlaceholder(x));
    return labels.length > 0 && typedShare(labels) <= 0.2;
  });
  if (row.some((v, c) => isTyped(v) && !((hasText || corner) && labelLike(v, below(c))))) return false;
  if (row.some((_, c) => typedShare(below(c)) >= 0.8)) return true;
  const columns = row.map((_, c) => body.map((r) => r[c]));
  // A merged cell filled across repeats its value in neighbouring cells; that is one label.
  const spans = filled.filter((v, i) => v !== filled[i - 1]);
  return new Set(spans).size === spans.length && row.every((v, c) => !v || !columns[c].includes(v));
}

/** A row below the header that continues it: all text, under a spanning row or over a typed body. */
function continuesHeader(row: string[], above: string[], body: string[][]): boolean {
  const filled = row.filter(Boolean);
  const column = (c: number) => body.map((r) => r[c]);
  if (filled.length < row.length / 2 || row.some((v, c) => isTyped(v) && !labelLike(v, column(c)))) return false;
  if (above.some((c) => !c)) return true;
  return row.some((v, c) => !isPlaceholder(v) && (!isTyped(v) || cellKind(v) === "date") && typedShare(column(c)) >= 0.8);
}

/** Header labels for the leading rows: distinct parts joined top-down, blanks named, duplicates numbered. */
export function headerLabels(headerRows: string[][], width: number): string[] {
  const raw = Array.from({ length: width }, (_, c) => {
    const parts: string[] = [];
    for (const r of headerRows) {
      const v = (r[c] ?? "").trim();
      if (v && !parts.includes(v)) parts.push(v);
    }
    return parts.join(" · ");
  });
  const seen = new Map<string, number>();
  return raw.map((l, c) => {
    let label = (l || `Column ${c + 1}`).slice(0, MAX_LABEL_CHARS).trim();
    const n = (seen.get(label.toLowerCase()) ?? 0) + 1;
    seen.set(label.toLowerCase(), n);
    if (n > 1) label = `${label.slice(0, MAX_LABEL_CHARS - 6)} (${n})`;
    return label;
  });
}

/**
 * Which leading rows of a grid are header, and their labels (§3.3). Pass
 * `headerRows` when the header is already known (Gemini gives it apart from
 * the rows); detection is then skipped, and so is the title row.
 */
export function detectHeader(grid: string[][], headerRows?: number): HeaderDetection {
  const prepared = headerRows === undefined ? prepareGrid(grid) : { ...trimGrid(grid), title: null };
  const { rows, title, columnMap } = prepared;
  const width = columnMap.length;

  if (headerRows !== undefined) {
    const n = Math.min(headerRows, rows.length);
    const body = rows.slice(n).filter((r) => r.some(Boolean));
    return { header_rows: n, labels: headerLabels(rows.slice(0, n), width), title, rows: [...rows.slice(0, n), ...body], columnMap };
  }

  const none = { header_rows: 0, labels: headerLabels([], width), title, rows, columnMap };
  if (rows.length < 2) {
    // A lone text row is a header with no body (the builder then has no table), not data.
    const lone = rows[0] ?? [];
    const filled = lone.filter(Boolean);
    return filled.length && filled.length >= width / 2 && !filled.some((c) => isTyped(c)) ? { ...none, header_rows: 1, labels: headerLabels([lone], width) } : none;
  }

  let header: string[][] = [];
  if (isHeaderRow0(rows[0], rows.slice(1))) {
    header = [rows[0]];
  } else if (rows.length > 2 && rows[0].some(Boolean) && continuesHeader(rows[1], rows[0], rows.slice(2))) {
    // A spanning first row written with blanks (a CSV of a merged header): read it filled across.
    const filled = fillAcross(rows[0]);
    const raw = rows[0].filter(Boolean);
    const labels = rows[0].every((v, c) => !isTyped(v) || labelLike(v, rows.slice(2).map((r) => r[c])));
    if (new Set(raw).size === raw.length && filled.filter(Boolean).length >= width / 2 && labels) header = [filled];
  }
  if (!header.length) return none;

  // Up to two more header rows, while something is left for the body.
  while (header.length < 3 && rows.length > header.length + 1) {
    const i = header.length;
    if (!continuesHeader(rows[i], rows[i - 1], rows.slice(i + 1))) break;
    // A spanning row above: what it spans continues across its blanks.
    if (rows[i - 1].some((c) => !c)) header[i - 1] = fillAcross(header[i - 1]);
    header.push(rows[i]);
  }
  return { header_rows: header.length, labels: headerLabels(header, width), title, rows: [...header, ...rows.slice(header.length)], columnMap };
}
