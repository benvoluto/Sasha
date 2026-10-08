import { describe, expect, it } from "vitest";
import type { ExtractedTable } from "./contract";
import { LONG_SPREADSHEET_WARNING, renderTablesText } from "./render";

const table = (name: string, labels: string[], rows: (string | null)[][]): ExtractedTable => ({
  match_key: `sheet:${name}`,
  name,
  columns: labels.map((label, i) => ({ key: `c${i + 1}`, label, type: "text", inferred: "text", unit: null })),
  rows,
  extraction_method: "xlsx",
  sheet: name,
  page: null,
  page_end: null,
  confidence: null,
  notes: "",
  truncated: false,
});

describe("renderTablesText", () => {
  it("lays out each table under its name, tab-separated, blank line between", () => {
    const { text, warning } = renderTablesText([table("Costs", ["Item", "Cost"], [["Paper", "$5"], ["Ink", null]]), table("Staff", ["Name", "Role"], [["Ann", "Lead"]])]);
    expect(text).toBe("## Costs\nItem\tCost\nPaper\t$5\nInk\t\n\n## Staff\nName\tRole\nAnn\tLead");
    expect(warning).toBeNull();
  });

  it("turns tabs and line breaks inside cells into spaces", () => {
    const { text } = renderTablesText([table("T", ["a\tb", "c"], [["x\ty", "line\nbreak"]])]);
    expect(text).toBe("## T\na b\tc\nx y\tline break");
  });

  it("drops NUL and lone surrogates, which Postgres TEXT can't hold", () => {
    const { text } = renderTablesText([table("T\u0000", ["a\u0000", "c"], [["x\uD800", null]])]);
    expect(text).toBe("## T\na\tc\nx\uFFFD\t");
  });

  it("caps the text at a line break and warns", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`row ${i}`, "value"]);
    const { text, warning } = renderTablesText([table("Long", ["a", "b"], rows)], 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith("value")).toBe(true);
    expect(warning).toBe(LONG_SPREADSHEET_WARNING);
  });
});
