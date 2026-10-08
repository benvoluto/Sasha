import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildTable } from "./build";
import { readXlsx, SpreadsheetError } from "./xlsx";
import { CFB_MESSAGE } from "./zip-guard";

type Sheet = { name: string; sheet: XLSX.WorkSheet; hidden?: boolean };

function workbook(sheets: Sheet[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, s.sheet, s.name);
  wb.Workbook = { Sheets: sheets.map((s) => ({ name: s.name, Hidden: s.hidden ? 1 : 0 })) };
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
const aoa = (rows: unknown[][]) => XLSX.utils.aoa_to_sheet(rows, { cellDates: true });

describe("readXlsx", () => {
  it("reads one grid per sheet, skipping empty sheets and noting hidden ones", () => {
    const { grids } = readXlsx(
      workbook([
        { name: "Costs", sheet: aoa([["Item", "Cost"], ["Paper", 5]]) },
        { name: "Blank", sheet: aoa([]) },
        { name: "Old", sheet: aoa([["Year", "Total"], [2020, 9]]), hidden: true },
      ]),
    );
    expect(grids.map((g) => g.name)).toEqual(["Costs", "Old"]);
    expect(grids[0]).toMatchObject({ match_key: "sheet:Costs", method: "xlsx", sheet: "Costs", cells: [["Item", "Cost"], ["Paper", "5"]], notes: [] });
    expect(grids[1].notes).toEqual(["Hidden sheet in the file."]);
  });

  it("drops NUL characters that SheetJS unescapes from cells and sheet names", () => {
    // _x0000_ in the XML comes back as a real U+0000, which Postgres TEXT and JSONB reject.
    const { grids } = readXlsx(workbook([{ name: "S\u0000x", sheet: aoa([["It\u0000em", "Cost"], ["a\u0000b", 1]]) }]));
    expect(grids[0]).toMatchObject({ name: "Sx", match_key: "sheet:Sx", sheet: "Sx", cells: [["Item", "Cost"], ["ab", "1"]] });
  });

  it("writes dates as yyyy-mm-dd and keeps formatted numbers", () => {
    const sheet = aoa([["When", "Amount"], [null, 1234.5]]);
    // As Excel stores it: a serial number with a date format (45306 is 15 January 2024).
    sheet["A2"] = { t: "n", v: 45306, z: "d mmm yyyy" };
    sheet["B2"].z = "#,##0.00";
    const { grids } = readXlsx(workbook([{ name: "S", sheet }]));
    expect(grids[0].cells[1]).toEqual(["2024-01-15", "1,234.50"]);
    const t = buildTable(grids[0])!;
    expect(t.columns.map((c) => c.type)).toEqual(["date", "number"]);
  });

  it("keeps the time of a date-time cell and reads a time-only cell as a time", () => {
    const sheet = aoa([["When", "Shift", "Start", "Total", "Day"], [null, null, null, null, null]]);
    sheet["A2"] = { t: "n", v: 45293 + 13.75 / 24, z: "yyyy-mm-dd hh:mm" };
    sheet["B2"] = { t: "n", v: 0.5, z: "h:mm" };
    sheet["C2"] = { t: "n", v: 0.25 + 30 / 86400, z: "h:mm:ss AM/PM" };
    sheet["D2"] = { t: "n", v: 1.5, z: "[h]:mm" };
    sheet["E2"] = { t: "n", v: 45293.6, z: "d mmm yyyy" };
    const { grids } = readXlsx(workbook([{ name: "S", sheet }]));
    expect(grids[0].cells[1]).toEqual(["2024-01-02 13:45", "12:00", "06:00:30", "36:00", "2024-01-02"]);
  });

  it("reads a header row of real date cells over monthly figures", () => {
    const sheet = aoa([["Region", null, null], ["North", 10, 20], ["South", 30, 40]]);
    sheet["B1"] = { t: "n", v: 45322, z: "mmm-yy" };
    sheet["C1"] = { t: "n", v: 45351, z: "mmm-yy" };
    const t = buildTable(readXlsx(workbook([{ name: "S", sheet }])).grids[0])!;
    expect(t.columns.map((c) => [c.label, c.type])).toEqual([["Region", "text"], ["2024-01-31", "number"], ["2024-02-29", "number"]]);
    expect(t.rows).toHaveLength(2);
  });

  it("reads a formula's cached value and never evaluates one", () => {
    const sheet = aoa([["Label", "Value"], ["sum", null], ["link", null]]);
    sheet["B2"] = { t: "n", f: "1+1", v: 2 };
    sheet["B3"] = { t: "s", f: 'HYPERLINK("http://example.invalid","click")' } as XLSX.CellObject;
    const { grids } = readXlsx(workbook([{ name: "F", sheet }]));
    expect(grids[0].cells).toEqual([["Label", "Value"], ["sum", "2"], ["link", ""]]);
  });

  it("fills merged header cells across, but not a lone merged title", () => {
    const sheet = aoa([
      ["Report", null, null],
      ["Region", "Revenue", null],
      [null, "Q1", "Q2"],
      ["North", 1, 2],
      ["South", 3, 4],
    ]);
    sheet["!merges"] = [XLSX.utils.decode_range("A1:C1"), XLSX.utils.decode_range("B2:C2"), XLSX.utils.decode_range("A2:A3")];
    const { grids } = readXlsx(workbook([{ name: "Sheet1", sheet }]));
    expect(grids[0].cells.slice(0, 3)).toEqual([
      ["Report", "", ""],
      ["Region", "Revenue", "Revenue"],
      ["Region", "Q1", "Q2"],
    ]);
    const t = buildTable(grids[0])!;
    expect(t.name).toBe("Report");
    expect(t.columns.map((c) => c.label)).toEqual(["Region", "Revenue · Q1", "Revenue · Q2"]);
    expect(t.rows).toEqual([["North", "1", "2"], ["South", "3", "4"]]);
  });

  it("keeps merge filling inside the header rows however many merges a sheet lists", () => {
    const rows: unknown[][] = [["a", "b"], ...Array.from({ length: 3000 }, (_, i) => [String(i), null])];
    const sheet = aoa(rows);
    sheet["!ref"] = "A1:CV3001";
    sheet["!merges"] = Array.from({ length: 5000 }, () => XLSX.utils.decode_range("A1:CV3001"));
    const started = Date.now();
    const { grids } = readXlsx(workbook([{ name: "M", sheet }]));
    expect(Date.now() - started).toBeLessThan(3000);
    // Only the header zone is filled; the body keeps its own (empty) cells.
    expect(grids[0].cells[0].slice(0, 3)).toEqual(["a", "b", "a"]);
    expect(grids[0].cells[10][1]).toBe("");
  });

  it("clamps a sheet's range to the column limit", () => {
    const sheet = aoa([["a", "b"], ["1", "2"]]);
    sheet["DA1"] = { t: "s", v: "far" };
    sheet["!ref"] = "A1:DA2";
    const { grids } = readXlsx(workbook([{ name: "Wide", sheet }]));
    expect(grids[0].cells[0]).toHaveLength(100);
    expect(grids[0].truncated).toBe(true);
    expect(grids[0].notes).toContain("Only the first 100 columns were kept.");
    expect(buildTable(grids[0])!.columns.map((c) => c.label)).toEqual(["a", "b"]);
  });

  it("stays quick when a sheet claims A1:XFD1048576", () => {
    // The writer would walk that range, so forge the dimension in the written file instead.
    const z = XLSX.CFB.read(Buffer.from(workbook([{ name: "Huge", sheet: aoa([["a", "b"], ["1", "2"]]) }])), { type: "buffer" });
    const xml = Buffer.from(XLSX.CFB.find(z, "/xl/worksheets/sheet1.xml").content).toString().replace('ref="A1:B2"', 'ref="A1:XFD1048576"');
    expect(xml).toContain("XFD1048576");
    XLSX.CFB.utils.cfb_add(z, "/xl/worksheets/sheet1.xml", Buffer.from(xml));
    const forged = new Uint8Array(XLSX.CFB.write(z, { fileType: "zip", type: "buffer" }));
    const started = Date.now();
    const { grids } = readXlsx(forged);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(grids[0].cells).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("refuses an encrypted or legacy file, and garbage", () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, ...new Array(600).fill(0)]);
    expect(() => readXlsx(cfb)).toThrow(new SpreadsheetError(CFB_MESSAGE));
    expect(() => readXlsx(new TextEncoder().encode("not a spreadsheet"))).toThrow(SpreadsheetError);
  });
});
