// A spreadsheet's tables as plain text (phase5-spec.md §3.6), so an .xlsx gets
// passages, citations and a summary like any other source. Pure.

import { MAX_PASSAGE_TEXT_CHARS } from "@/lib/sources/pages";
import { storableText, type ExtractedTable } from "./contract";

export const LONG_SPREADSHEET_WARNING = "This spreadsheet is very long; only the first part was read.";

const flat = (s: string | null) => storableText(s ?? "").replace(/[\t\r\n]+/g, " ");

/**
 * "## name", a tab-separated header line, then one line per row; tables
 * separated by a blank line. Capped at what passages can hold, with the
 * warning to show when it was cut.
 */
export function renderTablesText(tables: ExtractedTable[], max = MAX_PASSAGE_TEXT_CHARS): { text: string; warning: string | null } {
  const text = tables
    .map((t) => [`## ${flat(t.name)}`, t.columns.map((c) => flat(c.label)).join("\t"), ...t.rows.map((r) => t.columns.map((_, i) => flat(r[i] ?? null)).join("\t"))].join("\n"))
    .join("\n\n");
  if (text.length <= max) return { text, warning: null };
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return { text: nl > 0 ? cut.slice(0, nl) : cut, warning: LONG_SPREADSHEET_WARNING };
}
