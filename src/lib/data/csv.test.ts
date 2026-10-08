import { describe, expect, it } from "vitest";
import { MAX_TABLE_ROWS } from "./contract";
import { buildTable } from "./build";
import { decodeCsv, parseCsv } from "./csv";

const enc = (s: string) => new TextEncoder().encode(s);
const table = (s: string | Uint8Array, name = "data.csv") => {
  const g = parseCsv(typeof s === "string" ? enc(s) : s, name);
  return g && buildTable(g);
};

describe("parseCsv", () => {
  it("sniffs comma, semicolon and tab delimiters", () => {
    for (const d of [",", ";", "\t"]) {
      const t = table(`Name${d}Amount\nAnn${d}12\nBo${d}30\n`)!;
      expect(t.columns.map((c) => c.label)).toEqual(["Name", "Amount"]);
      expect(t.rows).toEqual([["Ann", "12"], ["Bo", "30"]]);
    }
  });

  it("names the grid after the file and marks it csv", () => {
    const g = parseCsv(enc("a,b\n1,2\n"), "Q1 report.final.csv")!;
    expect(g).toMatchObject({ name: "Q1 report.final", match_key: "csv", method: "csv", truncated: false });
  });

  it("keeps quoted fields with commas and line breaks", () => {
    const t = table('Name,Note\n"Smith, Ann","line one\nline two"\nBo,ok\n')!;
    expect(t.rows[0]).toEqual(["Smith, Ann", "line one\nline two"]);
  });

  it("strips a UTF-8 BOM and reads UTF-16 with a BOM", () => {
    expect(table("﻿Name,Amount\nAnn,1\n")!.columns[0].label).toBe("Name");
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(Buffer.from("Name,Amount\nAnn,1\n", "utf16le"))]);
    expect(decodeCsv(utf16)).toBe("Name,Amount\nAnn,1\n");
  });

  it("falls back to windows-1252 when the bytes aren't UTF-8", () => {
    // "Café,€5" as saved by older Excel: é = E9, € = 80.
    const bytes = new Uint8Array([...enc("Name,Price\nCaf"), 0xe9, ...enc(","), 0x80, ...enc("5\n")]);
    const t = table(bytes)!;
    expect(t.rows[0]).toEqual(["Café", "€5"]);
  });

  it("pads ragged rows", () => {
    const t = table("a,b,c\n1,2\n3,4,5,\n")!;
    expect(t.rows).toEqual([["1", "2", null], ["3", "4", "5"]]);
  });

  it("caps rows and marks the table truncated", () => {
    const lines = ["n,v", ...Array.from({ length: MAX_TABLE_ROWS + 100 }, (_, i) => `${i},${i}`)];
    const t = table(lines.join("\n"))!;
    expect(t.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(t.truncated).toBe(true);
  });

  it("caps columns and marks the table truncated", () => {
    const header = Array.from({ length: 120 }, (_, i) => `h${i}`).join(",");
    const row = Array.from({ length: 120 }, (_, i) => i).join(",");
    const t = table(`${header}\n${row}\n`)!;
    expect(t.columns).toHaveLength(100);
    expect(t.truncated).toBe(true);
  });

  it("has no table for an empty or blank file, or one column", () => {
    expect(parseCsv(enc(""), "a.csv")).toBeNull();
    expect(parseCsv(enc("\n\n , \n"), "a.csv")).toBeNull();
    expect(table("just\none\ncolumn\n")).toBeNull();
  });
});
