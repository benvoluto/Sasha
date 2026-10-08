import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INSERT_ROWS, MAX_INSERT_ROWS, MAX_ROWS_PAGE, type DataRow, type DataTableSummary } from "@/lib/data/contract";
import {
  appendRows,
  canHaveTables,
  canUseNewer,
  cellEdit,
  collectRows,
  countBySource,
  insertChoices,
  matchesQuery,
  mergeTable,
  methodLabel,
  overrideTitle,
  pickerGroups,
  prefillCompletion,
  readingText,
  replaceRow,
  replacementCandidates,
  shapeText,
  statusChips,
  tableMeta,
  typeBadge,
} from "./data-pane-model";

let n = 0;
const table = (over: Partial<DataTableSummary> = {}): DataTableSummary => {
  n += 1;
  return {
    id: `t${n}`,
    source_id: "s1",
    source: { id: "s1", title: null, filename: "Budget.xlsx", kind: "file", mime: null },
    name: `Table ${n}`,
    columns: [
      { key: "c1", label: "Item", type: "text", inferred: "text", unit: null },
      { key: "c2", label: "Amount", type: "currency", inferred: "currency", unit: "€" },
    ],
    row_count: 40,
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
  };
};

describe("card text", () => {
  it("names the method, the shape and where the table came from", () => {
    expect(["csv", "xlsx", "gemini-pdf", "gemini-image"].map((m) => methodLabel(m as never))).toEqual(["CSV", "Spreadsheet", "PDF", "Image"]);
    expect(shapeText(table({ row_count: 1200 }))).toBe("1,200 rows × 2 columns");
    expect(shapeText({ row_count: 1, columns: [table().columns[0]] })).toBe("1 row × 1 column");
    expect(tableMeta(table())).toBe("Budget.xlsx · Sheet: 2024");
    expect(tableMeta(table({ sheet: null, source: { id: "s", title: "Report", filename: "r.pdf", kind: "file", mime: null }, page: 3, page_end: 3 }))).toBe("Report · p. 3");
    expect(tableMeta(table({ sheet: null }))).toBe("Budget.xlsx");
  });

  it("shows status chips for hidden, superseded, low confidence, truncated and changed cells", () => {
    expect(statusChips(table())).toEqual([]);
    expect(statusChips(table({ status: "hidden", truncated: true, override_count: 3, confidence: 0.4 })).map((c) => [c.label, c.tone])).toEqual([
      ["Hidden", "quiet"],
      ["Low confidence", "warn"],
      ["Truncated", "quiet"],
      ["3 changed cells", "accent"],
    ]);
    expect(statusChips(table({ status: "superseded", override_count: 1, confidence: 0.6 })).map((c) => c.label)).toEqual(["Superseded", "1 changed cell"]);
    expect(canUseNewer(table({ status: "superseded", superseded_by: "t9" }))).toBe(true);
    expect(canUseNewer(table({ status: "superseded" }))).toBe(false);
    expect(canUseNewer(table({ superseded_by: "t9" }))).toBe(false);
  });

  it("labels each column type for the eye and for a screen reader", () => {
    expect(typeBadge({ type: "number", unit: null })).toEqual({ text: "123", label: "Number" });
    expect(typeBadge({ type: "currency", unit: "€" })).toEqual({ text: "€", label: "Currency (€)" });
    expect(typeBadge({ type: "currency", unit: null })).toEqual({ text: "$", label: "Currency" });
    expect(typeBadge({ type: "percent", unit: "%" })).toEqual({ text: "%", label: "Percent" });
    expect(typeBadge({ type: "date", unit: null })).toMatchObject({ label: "Date", icon: "calendar" });
    expect(typeBadge({ type: "text", unit: null })).toEqual({ text: "Aa", label: "Text" });
  });

  it("says what a changed cell was and who changed it", () => {
    expect(overrideTitle({ original: "12", by: "Ana", at: "2026-10-08T10:00:00.000Z" }, "en-GB")).toBe('Changed from "12" by Ana, 8 Oct 2026');
    expect(overrideTitle({ original: null, by: "", at: "2026-10-08T10:00:00.000Z" }, "en-GB")).toBe("Changed from empty by someone, 8 Oct 2026");
  });
});

describe("insert row choices", () => {
  it("offers the standard counts below the table's size plus All N, defaulting to 25", () => {
    expect(insertChoices(40)).toEqual({
      choices: [
        { value: 10, label: "First 10" },
        { value: 25, label: "First 25" },
        { value: 40, label: "All 40" },
      ],
      initial: DEFAULT_INSERT_ROWS,
    });
  });

  it("defaults to all rows for a small table, and offers no All for one bigger than the limit", () => {
    expect(insertChoices(7)).toEqual({ choices: [{ value: 7, label: "All 7" }], initial: 7 });
    expect(insertChoices(25).choices.map((c) => c.label)).toEqual(["First 10", "All 25"]);
    expect(insertChoices(25).initial).toBe(25);
    const big = insertChoices(5000);
    expect(big.choices.map((c) => c.value)).toEqual([10, 25, 50, 100, 200]);
    expect(big.choices.every((c) => c.value <= MAX_INSERT_ROWS)).toBe(true);
    expect(big.initial).toBe(25);
    expect(insertChoices(MAX_INSERT_ROWS).choices.at(-1)).toEqual({ value: 200, label: "All 200" });
    expect(insertChoices(0)).toEqual({ choices: [], initial: 0 });
  });

  it("collects rows page by page up to the count", async () => {
    const all: DataRow[] = Array.from({ length: 700 }, (_, idx) => ({ idx, cells: [String(idx)] }));
    const t = table({ row_count: 700 });
    const fetchPage = vi.fn(async (offset: number, limit: number) => {
      const rows = all.slice(offset, offset + Math.min(limit, 300));
      return { table: t, rows, next_offset: offset + rows.length < all.length ? offset + rows.length : null };
    });
    const got = await collectRows(fetchPage, 650);
    expect(got.rows).toHaveLength(650);
    expect(got.rows.at(-1)?.idx).toBe(649);
    expect(got.table).toBe(t);
    expect(fetchPage.mock.calls.every(([, limit]) => limit <= MAX_ROWS_PAGE)).toBe(true);
    const short = await collectRows(async () => ({ table: t, rows: all.slice(0, 3), next_offset: null }), 25);
    expect(short.rows).toHaveLength(3);
  });
});

describe("rows and tables", () => {
  it("appends pages without duplicates and replaces a changed row", () => {
    const a = [{ idx: 0, cells: ["a"] }, { idx: 1, cells: ["b"] }];
    expect(appendRows(a, [{ idx: 1, cells: ["b"] }, { idx: 2, cells: ["c"] }]).map((r) => r.idx)).toEqual([0, 1, 2]);
    expect(replaceRow(a, { idx: 1, cells: ["B"] })[1].cells).toEqual(["B"]);
  });

  it("merges a patched table into the linked list, keeping the link fields", () => {
    const t = { ...table(), added_by: "u", added_at: "x" };
    const [m] = mergeTable([t], { ...table({ name: "Renamed" }), id: t.id });
    expect(m).toMatchObject({ name: "Renamed", added_by: "u", added_at: "x" });
  });

  it("turns a cell edit into an override, a revert or nothing", () => {
    const col = { key: "c2" };
    const plain: DataRow = { idx: 4, cells: ["Rent", "12"] };
    const changed: DataRow = { idx: 4, cells: ["Rent", "15"], overrides: { c2: { original: "12", by: "Ana", at: "x" } } };
    expect(cellEdit(plain, col, 1, "12")).toBeNull();
    expect(cellEdit(plain, col, 1, "13")).toEqual({ op: "override", row: 4, key: "c2", value: "13" });
    expect(cellEdit(plain, col, 1, "  ")).toEqual({ op: "override", row: 4, key: "c2", value: null });
    expect(cellEdit(changed, col, 1, "12")).toEqual({ op: "revert", row: 4, key: "c2" });
    expect(cellEdit(changed, col, 1, "16")).toEqual({ op: "override", row: 4, key: "c2", value: "16" });
  });
});

describe("add-table picker", () => {
  it("groups the document's source tables first, the library after, and marks linked ones", () => {
    const a = table();
    const b = table();
    const c = table({ source_id: "s2" });
    const g = pickerGroups([a, b], [b, c], [b.id]);
    expect(g.fromDocument.map((r) => [r.table.id, r.linked])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
    expect(g.library.map((r) => [r.table.id, r.linked])).toEqual([[c.id, false]]);
  });

  it("matches a search on the name, column labels, source title or filename", () => {
    const t = table({ name: "Costs" });
    expect(matchesQuery(t, "")).toBe(true);
    expect(matchesQuery(t, "cost")).toBe(true);
    expect(matchesQuery(t, "amount")).toBe(true);
    expect(matchesQuery(t, "budget")).toBe(true);
    expect(matchesQuery(t, "revenue")).toBe(false);
  });
});

describe("replacement candidates", () => {
  it("lists the same source's other active tables first, then linked ones, never itself or a loop", () => {
    const t = table();
    const sibling = table();
    const hidden = table({ status: "hidden" });
    const otherSource = table({ source_id: "s2" });
    const linkedOther = table({ source_id: "s3" });
    const loop = table({ source_id: "s3", superseded_by: t.id });
    const got = replacementCandidates(t, [t, sibling, hidden, otherSource], [t, linkedOther, sibling, loop]);
    expect(got.map((x) => x.id)).toEqual([sibling.id, linkedOther.id]);
  });
});

describe("prefill", () => {
  it("marks the suggestion added with the linked table, and does nothing without a prefill", () => {
    expect(prefillCompletion({ suggestionId: "sg1", label: "Monthly sales" }, "t1")).toEqual({ suggestionId: "sg1", body: { action: "add", data_table_id: "t1" } });
    expect(prefillCompletion(null, "t1")).toBeNull();
  });
});

describe("sources", () => {
  it("knows which sources can have tables", () => {
    expect(canHaveTables({ kind: "file", mime: "text/csv" })).toBe(true);
    expect(canHaveTables({ kind: "file", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(true);
    expect(canHaveTables({ kind: "file", mime: "application/pdf" })).toBe(true);
    expect(canHaveTables({ kind: "file", mime: "image/png" })).toBe(true);
    expect(canHaveTables({ kind: "file", mime: null, filename: "a.CSV" })).toBe(true);
    expect(canHaveTables({ kind: "file", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe(false);
    expect(canHaveTables({ kind: "url", mime: "application/pdf" })).toBe(false);
    expect(canHaveTables({ kind: "note", mime: null })).toBe(false);
  });

  it("counts tables by source and says how many sources are being read", () => {
    expect([...countBySource([{ source_id: "a" }, { source_id: "b" }, { source_id: "a" }])]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(readingText(0)).toBeNull();
    expect(readingText(1)).toBe("Reading 1 source…");
    expect(readingText(3)).toBe("Reading 3 sources…");
  });
});
