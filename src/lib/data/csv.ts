// A CSV file's bytes → one grid (phase5-spec.md §3.1–3.2). Decodes the way a
// spreadsheet app would (BOM first, then strict UTF-8, then windows-1252 for
// files saved by older Excel), lets papaparse pick the delimiter, and reads no
// more than the table limits need.

import Papa from "papaparse";
import { MAX_TABLE_ROWS, type RawGrid } from "./contract";

/** Decoded text kept for parsing; the rest is cut and the table marked truncated. */
export const MAX_CSV_TEXT_CHARS = 20 * 1024 * 1024;
/** Rows parsed: the row limit, plus room for header and title rows so a longer file is seen as one. */
const PREVIEW_ROWS = MAX_TABLE_ROWS + 10;

// windows-1252 differs from latin1 only in 0x80–0x9F (€, curly quotes, dashes…).
// Node's TextDecoder treats the label as latin1 there, so map those by hand.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const codes = Array.from(bytes.subarray(at, at + CHUNK), (b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b));
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

/**
 * The file's text: BOM-led UTF-8 or UTF-16, else strict UTF-8, else
 * windows-1252. NUL characters are dropped: Postgres TEXT can't hold them.
 */
export function decodeCsv(bytes: Uint8Array): string {
  return decodeBytes(bytes).replace(/\u0000/g, "");
}

function decodeBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

/** The filename without its extension, as the table's name. */
export const baseName = (name: string) => name.replace(/\.[^./\\]+$/, "").trim() || name;

/** One grid for the whole file, or null when it holds no cells. */
export function parseCsv(bytes: Uint8Array, name: string): RawGrid | null {
  let text = decodeCsv(bytes);
  const notes: string[] = [];
  let truncated = false;
  if (text.length > MAX_CSV_TEXT_CHARS) {
    // Cut at the last line break so the final row isn't half a row.
    const cut = text.slice(0, MAX_CSV_TEXT_CHARS);
    const nl = cut.lastIndexOf("\n");
    text = nl > 0 ? cut.slice(0, nl) : cut;
    truncated = true;
    notes.push("Only the first 20 MB of the file were read.");
  }
  const parsed = Papa.parse<string[]>(text, {
    delimiter: "",
    delimitersToGuess: [",", ";", "\t", "|"],
    preview: PREVIEW_ROWS,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    header: false,
  });
  const cells = parsed.data.filter((r) => Array.isArray(r)).map((r) => r.map((c) => (c ?? "").toString()));
  if (!cells.some((r) => r.some((c) => c.trim()))) return null;
  return { name: baseName(name), match_key: "csv", cells, truncated, method: "csv", notes };
}
