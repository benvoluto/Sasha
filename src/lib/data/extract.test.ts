import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./gemini-tables", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gemini-tables")>()),
  readGeminiTables: mocks.read,
}));

import { MAX_TABLES_PER_SOURCE, type RawGrid } from "./contract";
import { CSV_MIME, extractGeminiTables, extractSpreadsheetTables, tablesFromGrids, TOO_MANY_TABLES, XLSX_MIME } from "./extract";
import { CFB_MESSAGE } from "./zip-guard";

const grid = (name: string, cells: string[][]): RawGrid => ({ name, match_key: `sheet:${name}`, cells, truncated: false, method: "xlsx", sheet: name });

describe("tablesFromGrids", () => {
  it("drops grids that aren't tables and numbers fallback names by kept position", () => {
    const { tables, warnings } = tablesFromGrids([grid("one col", [["a"], ["b"]]), grid("", [["x", "y"], ["1", "2"]])]);
    expect(tables.map((t) => t.name)).toEqual(["Table 1"]);
    expect(warnings).toEqual([]);
  });

  it("keeps at most MAX_TABLES_PER_SOURCE and warns", () => {
    const many = Array.from({ length: MAX_TABLES_PER_SOURCE + 3 }, (_, i) => grid(`S${i}`, [["a", "b"], ["1", "2"]]));
    const { tables, warnings } = tablesFromGrids(many);
    expect(tables).toHaveLength(MAX_TABLES_PER_SOURCE);
    expect(warnings).toEqual([TOO_MANY_TABLES]);
  });
});

describe("extractSpreadsheetTables", () => {
  it("reads a CSV as one table", async () => {
    const out = await extractSpreadsheetTables(new TextEncoder().encode("Name,Amount\nAnn,1\n"), { name: "people.csv", mime: CSV_MIME });
    expect(out).toMatchObject({ ok: true, warnings: [], tables: [{ name: "people", match_key: "csv", extraction_method: "csv" }] });
  });

  it("is ok with no tables for an empty CSV", async () => {
    expect(await extractSpreadsheetTables(new Uint8Array(0), { name: "e.csv", mime: CSV_MIME })).toEqual({ ok: true, tables: [], warnings: [] });
  });

  it("reads an XLSX sheet by sheet", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item", "Cost"], ["Paper", 5]]), "Costs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Role"], ["Ann", "Lead"]]), "Staff");
    const out = await extractSpreadsheetTables(new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), { name: "b.xlsx", mime: XLSX_MIME });
    expect(out.ok && out.tables.map((t) => [t.name, t.sheet, t.match_key])).toEqual([
      ["Costs", "Costs", "sheet:Costs"],
      ["Staff", "Staff", "sheet:Staff"],
    ]);
  });

  it("is not ok for an XLSX that can't be opened", async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, ...new Array(100).fill(0)]);
    expect(await extractSpreadsheetTables(cfb, { name: "locked.xlsx", mime: XLSX_MIME })).toEqual({ ok: false, reason: CFB_MESSAGE });
  });
});

describe("extractGeminiTables", () => {
  beforeEach(() => {
    mocks.read.mockReset();
  });

  it("builds the grids Gemini read into tables, keeping its warnings", async () => {
    mocks.read.mockResolvedValue({
      ok: true,
      grids: [{ name: "Budget", match_key: "page:2#1", cells: [["Item", "Cost"], ["Paper", "$5"]], header_rows: 1, truncated: false, method: "gemini-pdf", page: 2, page_end: null, confidence: 0.9, notes: [] }],
      warnings: ["Pages 11–20: tables couldn't be read."],
      dropped: [],
    });
    const out = await extractGeminiTables(Buffer.from("%PDF"), { name: "r.pdf", mime: "application/pdf" }, { deadline: 123 });
    expect(mocks.read).toHaveBeenCalledWith(Buffer.from("%PDF"), { name: "r.pdf", mime: "application/pdf" }, { deadline: 123 });
    expect(out).toMatchObject({ ok: true, warnings: ["Pages 11–20: tables couldn't be read."], tables: [{ name: "Budget", page: 2, confidence: 0.9 }] });
  });

  it("passes a failed pass through", async () => {
    mocks.read.mockResolvedValue({ ok: false, reason: "Table reading isn't configured." });
    expect(await extractGeminiTables(Buffer.from(""), { name: "r.pdf", mime: "application/pdf" })).toEqual({ ok: false, reason: "Table reading isn't configured." });
  });

  it("never throws", async () => {
    mocks.read.mockImplementation(async () => {
      throw new Error("boom");
    });
    const out = await extractGeminiTables(Buffer.from(""), { name: "r.pdf", mime: "application/pdf" });
    expect(out.ok).toBe(false);
  });
});
