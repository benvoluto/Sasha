import { describe, expect, it } from "vitest";
import { MAX_CELL_CHARS, MAX_TABLE_COLS, MAX_TABLE_ROWS, type RawGrid } from "./contract";
import { buildTable, cutCell } from "./build";

const grid = (cells: string[][], extra: Partial<RawGrid> = {}): RawGrid => ({ name: "budget", match_key: "csv", cells, truncated: false, method: "csv", ...extra });

describe("buildTable", () => {
  it("builds keyed, typed columns and null empty cells, padding ragged rows", () => {
    const t = buildTable(grid([["Item", "Cost", "Note"], ["Paper", "$5"], ["Ink", "$9", "refill"]]))!;
    expect(t.columns).toEqual([
      { key: "c1", label: "Item", type: "text", inferred: "text", unit: null },
      { key: "c2", label: "Cost", type: "currency", inferred: "currency", unit: "$" },
      { key: "c3", label: "Note", type: "text", inferred: "text", unit: null },
    ]);
    expect(t.rows).toEqual([["Paper", "$5", null], ["Ink", "$9", "refill"]]);
    expect(t).toMatchObject({ name: "budget", match_key: "csv", extraction_method: "csv", sheet: null, page: null, confidence: null, notes: "", truncated: false });
  });

  it("drops NUL and lone surrogates from cells, labels, name and sheet", () => {
    const t = buildTable(grid([["It\u0000em", "Cost"], ["a\u0000b", "\uD8001"]], { name: "S\u0000x", match_key: "sheet:S\u0000x", sheet: "S\u0000x", notes: ["n\u0000"] }))!;
    expect(t.columns.map((c) => c.label)).toEqual(["Item", "Cost"]);
    expect(t.rows).toEqual([["ab", "\uFFFD1"]]);
    expect(t).toMatchObject({ name: "Sx", match_key: "sheet:Sx", sheet: "Sx", notes: "n" });
  });

  it("never cuts a cell between the halves of a surrogate pair", () => {
    const cut = cutCell(`${"a".repeat(8)}😀xyz`, 10);
    expect(cut).toBe(`${"a".repeat(8)}…`);
  });

  it("returns null for one column or no data rows", () => {
    expect(buildTable(grid([["a"], ["b"]]))).toBeNull();
    expect(buildTable(grid([["Item", "Cost"]]))).toBeNull();
    expect(buildTable(grid([]))).toBeNull();
  });

  it("cuts rows, columns and cells, and says so", () => {
    const wide = [Array.from({ length: MAX_TABLE_COLS + 5 }, (_, i) => `H${i}`), Array.from({ length: MAX_TABLE_COLS + 5 }, (_, i) => String(i))];
    const w = buildTable(grid(wide))!;
    expect(w.columns).toHaveLength(MAX_TABLE_COLS);
    expect(w.truncated).toBe(true);
    expect(w.notes).toContain(`Only the first ${MAX_TABLE_COLS} columns were kept.`);

    const long = [["n", "sq"], ...Array.from({ length: MAX_TABLE_ROWS + 3 }, (_, i) => [String(i), String(i * i)])];
    const l = buildTable(grid(long))!;
    expect(l.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(l.truncated).toBe(true);
    expect(l.notes).toContain("Only the first 5,000 rows were kept.");

    const big = buildTable(grid([["a", "b"], ["x".repeat(MAX_CELL_CHARS + 50), "y"]]))!;
    expect(big.rows[0][0]).toHaveLength(MAX_CELL_CHARS);
    expect(big.rows[0][0]!.endsWith("…")).toBe(true);
    expect(cutCell("abc", 2)).toBe("a…");
  });

  it("names a generic sheet from its title row, and falls back to Table N", () => {
    const sheet = (name: string) => grid([["Budget 2024", ""], ["Item", "Cost"], ["Paper", "5"]], { name, method: "xlsx", sheet: name, match_key: `sheet:${name}` });
    expect(buildTable(sheet("Sheet1"))!.name).toBe("Budget 2024");
    expect(buildTable(sheet("Costs"))!.name).toBe("Costs");
    expect(buildTable(grid([["a", "b"], ["1", "2"]], { name: "" }), { index: 2 })!.name).toBe("Table 3");
  });

  it("passes through Gemini's header, page, confidence and notes", () => {
    const t = buildTable(
      grid([["Year", "Total"], ["2023", "10"]], { method: "gemini-pdf", header_rows: 1, page: 4, page_end: 5, confidence: 0.5, notes: ["Low confidence; check against the file."], truncated: false, match_key: "page:4#1" }),
    )!;
    expect(t).toMatchObject({ extraction_method: "gemini-pdf", page: 4, page_end: 5, confidence: 0.5, notes: "Low confidence; check against the file.", match_key: "page:4#1" });
    expect(t.columns.map((c) => c.label)).toEqual(["Year", "Total"]);
  });
});
