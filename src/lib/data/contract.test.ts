import { describe, expect, it } from "vitest";
import { csvField, DataTablePatch, neutralizeFormula, storableText, tableCitationHref, TableListQuery, tableLocation, TableRowsQuery, toCsv } from "./contract";

describe("neutralizeFormula", () => {
  it("prefixes text a spreadsheet would run", () => {
    for (const s of ["=cmd|' /C calc'!A0", "+SUM(1)", "-2+3", "@SUM(A1)", "\tx", "\rx", "=1+1", "-", "+"]) expect(neutralizeFormula(s)).toBe(`'${s}`);
  });

  it("leaves plain numbers, ordinary text and empty cells alone", () => {
    for (const s of ["-12.5", "+3%", "-1,234.50", "12", "Rent", "a=b", ""]) expect(neutralizeFormula(s)).toBe(s);
    expect(neutralizeFormula(null)).toBe("");
  });
});

describe("storableText", () => {
  it("drops NUL and replaces lone surrogates, keeping real pairs", () => {
    expect(storableText("a\u0000b")).toBe("ab");
    expect(storableText("x\uD800y\uDC00")).toBe("x\uFFFDy\uFFFD");
    expect(storableText("emoji 😀")).toBe("emoji 😀");
  });
});

describe("csvField and toCsv", () => {
  it("quotes commas, quotes and line breaks after neutralizing", () => {
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(null)).toBe("");
    // Quoted so a ;- or tab-separated reading can't split off "=1+1" as its own cell.
    expect(csvField("a;=1+1")).toBe('"a;=1+1"');
    expect(csvField("a\t=1+1")).toBe('"a\t=1+1"');
  });

  it("writes the header and rows with CRLF line ends, padding short rows", () => {
    expect(toCsv([{ label: "Item" }, { label: "Cost, £" }], [["Rent", "100"], ["=cmd"]])).toBe('Item,"Cost, £"\r\nRent,100\r\n\'=cmd,\r\n');
  });
});

describe("TableListQuery", () => {
  const U = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";

  it("defaults status to active and splits, trims and dedupes a list", () => {
    expect(TableListQuery.parse({}).status).toEqual(["active"]);
    expect(TableListQuery.parse({ status: " hidden, active ,hidden" }).status).toEqual(["hidden", "active"]);
    expect(TableListQuery.parse({ source_id: U, for_document: U, q: "  rent " })).toMatchObject({ source_id: U, for_document: U, q: "rent" });
  });

  it("rejects unknown statuses, bad ids and unknown keys", () => {
    expect(TableListQuery.safeParse({ status: "deleted" }).success).toBe(false);
    expect(TableListQuery.safeParse({ status: "," }).success).toBe(false);
    expect(TableListQuery.safeParse({ document_id: "nope" }).success).toBe(false);
    expect(TableListQuery.safeParse({ page: "2" }).success).toBe(false);
    expect(TableListQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });
});

describe("TableRowsQuery and DataTablePatch", () => {
  it("coerces paging and caps the page size", () => {
    expect(TableRowsQuery.parse({})).toEqual({ offset: 0, limit: 100 });
    expect(TableRowsQuery.parse({ offset: "20", limit: "50" })).toEqual({ offset: 20, limit: 50 });
    expect(TableRowsQuery.safeParse({ limit: "501" }).success).toBe(false);
    expect(TableRowsQuery.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("takes one change per request", () => {
    expect(DataTablePatch.safeParse({ op: "override", row: 0, key: "c2", value: null }).success).toBe(true);
    // Postgres can't hold NUL or a lone surrogate: dropped / replaced before the store sees them.
    expect(DataTablePatch.parse({ op: "override", row: 0, key: "c2", value: "a\u0000b\uD800" })).toMatchObject({ value: "ab\uFFFD" });
    expect(DataTablePatch.parse({ op: "rename", name: " a\u0000 " })).toMatchObject({ name: "a" });
    expect(DataTablePatch.safeParse({ op: "rename", name: "\u0000" }).success).toBe(false);
    expect(DataTablePatch.safeParse({ op: "column", key: "c1", label: "\u0000 " }).success).toBe(false);
    expect(DataTablePatch.safeParse({ op: "column", key: "c1", type: null }).success).toBe(true);
    expect(DataTablePatch.safeParse({ op: "rename", name: "  " }).success).toBe(false);
    expect(DataTablePatch.safeParse({ op: "override", row: 0, key: "C2", value: "x" }).success).toBe(false);
    expect(DataTablePatch.safeParse({ op: "hide", extra: 1 }).success).toBe(false);
  });
});

describe("display helpers", () => {
  it("describes where a table sits and links back to it", () => {
    expect(tableLocation({ sheet: "Budget", page: null, page_end: null })).toBe("Sheet: Budget");
    expect(tableLocation({ sheet: null, page: 4, page_end: 5 })).toBe("pp. 4–5");
    expect(tableLocation({ sheet: null, page: 4, page_end: 4 })).toBe("p. 4");
    expect(tableLocation({ sheet: null, page: null, page_end: null })).toBe("");
    expect(tableCitationHref("s 1", "t&2")).toBe("/library?source=s%201&table=t%262");
  });
});
