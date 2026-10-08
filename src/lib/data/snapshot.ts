// A data table as TipTap content (phase5-spec.md §5.3): "Insert table" in the
// Data tab puts a snapshot of the table at the cursor, followed by a citation
// line linking back to the table in the library. Pure and client-safe; the
// table node's attributes are the DataTable extension's (extensions.ts).
//
// The snapshot is a copy: later overrides or re-reads don't change it. Every
// cell goes through neutralizeFormula, since documents export to formats a
// spreadsheet may open.

import type { PMNode } from "@/lib/documents/sections";
import { MAX_INSERT_ROWS, neutralizeFormula, tableCitationHref, tableLocation, type Cell, type TableSnapshot } from "./contract";

const paragraph = (text: string): PMNode => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });

const cellNode = (type: "tableHeader" | "tableCell", value: Cell): PMNode => ({ type, content: [paragraph(neutralizeFormula(value))] });

/**
 * The nodes to insert for `snapshot`: the table (a header row of column labels,
 * then at most `rows` rows, never more than MAX_INSERT_ROWS) and the citation
 * paragraph. `at` is when the snapshot was taken (ISO), kept on the table.
 */
export function tableSnapshotNodes(snapshot: TableSnapshot, opts: { rows: number; at: string }): PMNode[] {
  const { table } = snapshot;
  const count = Math.max(0, Math.min(opts.rows, MAX_INSERT_ROWS, snapshot.rows.length));
  const rows = snapshot.rows.slice(0, count);
  const header: PMNode = { type: "tableRow", content: table.columns.map((c) => cellNode("tableHeader", c.label)) };
  const body: PMNode[] = rows.map((r) => ({ type: "tableRow", content: table.columns.map((_, i) => cellNode("tableCell", r.cells[i] ?? null)) }));
  const tableNode: PMNode = {
    type: "table",
    attrs: { dataTableId: table.id, sourceId: table.source_id, snapshotAt: opts.at },
    content: [header, ...body],
  };

  const from = table.source.title || table.source.filename || "a source";
  const where = tableLocation(table);
  const cut = count < table.row_count ? ` First ${count.toLocaleString("en-US")} of ${table.row_count.toLocaleString("en-US")} rows.` : "";
  const citation: PMNode = {
    type: "paragraph",
    content: [
      { type: "text", text: "Source: " },
      { type: "text", text: table.name || "Table", marks: [{ type: "link", attrs: { href: tableCitationHref(table.source_id, table.id) } }] },
      { type: "text", text: ` — ${from}${where ? `, ${where}` : ""}.${cut}` },
    ],
  };
  return [tableNode, citation];
}
