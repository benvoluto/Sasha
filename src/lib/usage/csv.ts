// The usage CSV download (phase9-spec.md §3.3): one row per (day, user, task,
// model) in USAGE_CSV_COLUMNS order. Every field goes through csvField, which
// neutralises a leading = + - @ (an agent label or task name never opens as a
// formula) and quotes separators, as the data table download does.

import { csvField } from "@/lib/data/contract";
import { USAGE_CSV_COLUMNS } from "./contract";
import type { csvGroups } from "./query";

type CsvRow = ReturnType<typeof csvGroups>[number];

/** A whole CSV document with a header line and CRLF line ends. */
export function usageCsv(rows: CsvRow[]): string {
  const lines = [
    USAGE_CSV_COLUMNS.map((c) => csvField(c)),
    ...rows.map((r) => USAGE_CSV_COLUMNS.map((c) => csvField(r[c] === null ? "" : String(r[c])))),
  ];
  return lines.map((l) => l.join(",")).join("\r\n") + "\r\n";
}

/** The download's file name for a range. */
export const usageCsvFilename = (range: { from: string; to: string }) => `sasha-usage-${range.from}-to-${range.to}.csv`;
