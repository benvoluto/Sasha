import { describe, expect, it } from "vitest";
import { collectCitations } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import { MAX_INSERT_ROWS, tableCitationHref, type DataRow, type DataTableSummary } from "./contract";
import { tableSnapshotNodes } from "./snapshot";

const table = (over: Partial<DataTableSummary> = {}): DataTableSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  source_id: "22222222-2222-4222-8222-222222222222",
  source: { id: "22222222-2222-4222-8222-222222222222", title: null, filename: "Budget.xlsx", kind: "file", mime: null },
  name: "Costs",
  columns: [
    { key: "c1", label: "Item", type: "text", inferred: "text", unit: null },
    { key: "c2", label: "Amount", type: "currency", inferred: "currency", unit: "$" },
  ],
  row_count: 3,
  status: "active",
  superseded_by: null,
  extraction_method: "xlsx",
  sheet: "2024",
  page: null,
  page_end: null,
  confidence: null,
  notes: "",
  truncated: false,
  override_count: 0,
  document_ids: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

const rows = (n: number): DataRow[] => Array.from({ length: n }, (_, idx) => ({ idx, cells: [`Item ${idx + 1}`, `$${idx + 1}`] }));

const text = (n: PMNode): string => (n.text ?? "") + (n.content ?? []).map(text).join("");

describe("tableSnapshotNodes", () => {
  it("builds a table with a header row, a row per data row and the data-table attributes", () => {
    const [t, cite] = tableSnapshotNodes({ table: table(), rows: rows(3) }, { rows: 3, at: "2026-10-08T00:00:00.000Z" });
    expect(t.type).toBe("table");
    expect(t.attrs).toEqual({ dataTableId: table().id, sourceId: table().source_id, snapshotAt: "2026-10-08T00:00:00.000Z" });
    expect(t.content).toHaveLength(4);
    expect(t.content![0].content!.map((c) => [c.type, text(c)])).toEqual([
      ["tableHeader", "Item"],
      ["tableHeader", "Amount"],
    ]);
    expect(t.content![1].content!.map((c) => [c.type, text(c)])).toEqual([
      ["tableCell", "Item 1"],
      ["tableCell", "$1"],
    ]);
    expect(cite.type).toBe("paragraph");
    expect(text(cite)).toBe("Source: Costs — Budget.xlsx, Sheet: 2024.");
  });

  it("links the table name to the table in the library and cites the table", () => {
    const [, cite] = tableSnapshotNodes({ table: table(), rows: rows(3) }, { rows: 3, at: "x" });
    const link = cite.content!.find((n) => n.marks?.length);
    expect(link?.text).toBe("Costs");
    expect(link?.marks).toEqual([
      { type: "link", attrs: { href: tableCitationHref(table().source_id, table().id) } },
      { type: "citation", attrs: { kind: "table", passageId: null, sourceId: table().source_id, dataTableId: table().id, quote: null, verified: true } },
    ]);
    // The table is numbered among the document's sources cited.
    const { references } = collectCitations({ type: "doc", content: [cite] });
    expect(references).toMatchObject([{ key: `t:${table().id}`, number: 1, kind: "table", sourceId: table().source_id }]);
    expect(tableCitationHref(table().source_id, table().id)).toMatch(/^\/library\?source=.+&table=.+$/);
  });

  it("neutralizes formulas, keeps plain numbers, and leaves empty cells as empty paragraphs", () => {
    const r: DataRow[] = [{ idx: 0, cells: ["=HYPERLINK(\"x\")", "-12.5"] }, { idx: 1, cells: [null, "@sum"] }];
    const [t] = tableSnapshotNodes({ table: table({ row_count: 2 }), rows: r }, { rows: 2, at: "x" });
    const cells = t.content!.slice(1).map((row) => row.content!.map((c) => c.content![0]));
    expect(text(cells[0][0])).toBe("'=HYPERLINK(\"x\")");
    expect(text(cells[0][1])).toBe("-12.5");
    expect(cells[1][0]).toEqual({ type: "paragraph" });
    expect(text(cells[1][1])).toBe("'@sum");
  });

  it("says when only the first rows were inserted, and never inserts more than the limit", () => {
    const [t, cite] = tableSnapshotNodes({ table: table({ row_count: 1200 }), rows: rows(25) }, { rows: 25, at: "x" });
    expect(t.content).toHaveLength(26);
    expect(text(cite)).toBe("Source: Costs — Budget.xlsx, Sheet: 2024. First 25 of 1,200 rows.");
    const [big] = tableSnapshotNodes({ table: table({ row_count: 900 }), rows: rows(400) }, { rows: 400, at: "x" });
    expect(big.content).toHaveLength(MAX_INSERT_ROWS + 1);
  });

  it("pads short rows to the table's columns and uses the source title when there is one", () => {
    const t0 = table({ row_count: 1, sheet: null, page: 4, page_end: 5, source: { ...table().source, title: "Annual report" } });
    const [t, cite] = tableSnapshotNodes({ table: t0, rows: [{ idx: 0, cells: ["only"] }] }, { rows: 10, at: "x" });
    expect(t.content![1].content).toHaveLength(2);
    expect(text(cite)).toBe("Source: Costs — Annual report, pp. 4–5.");
  });
});
