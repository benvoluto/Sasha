import { describe, expect, it } from "vitest";
import { cellKind, detectHeader, inferColumn, inferColumnReading, isPlaceholder, parseCell, parseDate, parseNumber } from "./infer";

describe("parseNumber", () => {
  it("reads thousands, decimals and signs", () => {
    expect(parseNumber("1,234,567.89")).toBe(1234567.89);
    expect(parseNumber("1 234")).toBe(1234);
    expect(parseNumber("1 234 567")).toBe(1234567);
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber("+7")).toBe(7);
    expect(parseNumber("-3.25")).toBe(-3.25);
    expect(parseNumber("−3.25")).toBe(-3.25);
  });

  it("reads parentheses and trailing-minus negatives", () => {
    expect(parseNumber("(1,234)")).toBe(-1234);
    expect(parseNumber("1234-")).toBe(-1234);
  });

  it("refuses text, bad grouping and money", () => {
    expect(parseNumber("12 apples")).toBeNull();
    expect(parseNumber("1,23,4")).toBeNull();
    expect(parseNumber("$5")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });

  it("reads European digits when asked, and unambiguous ones without", () => {
    expect(parseNumber("1.234.567,89", true)).toBe(1234567.89);
    expect(parseNumber("12,5", true)).toBe(12.5);
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1,234")).toBe(1234);
  });
});

describe("parseDate", () => {
  it("reads ISO and slashed dates", () => {
    expect(parseDate("2024-01-05")).toBe("2024-01-05");
    expect(parseDate("2024-01-05T10:30:00Z")).toBe("2024-01-05");
    expect(parseDate("2024/1/5")).toBe("2024-01-05");
    expect(parseDate("1/5/2024")).toBe("2024-01-05");
    expect(parseDate("1/5/2024", true)).toBe("2024-05-01");
    expect(parseDate("25/12/2024")).toBe("2024-12-25");
    expect(parseDate("1/5/24")).toBe("2024-01-05");
  });

  it("reads month names", () => {
    expect(parseDate("5 Jan 2024")).toBe("2024-01-05");
    expect(parseDate("Jan 5, 2024")).toBe("2024-01-05");
    expect(parseDate("January 2024")).toBe("2024-01-01");
    expect(parseDate("2024-01")).toBe("2024-01-01");
    expect(parseDate("Sept 30, 2023")).toBe("2023-09-30");
  });

  it("refuses impossible dates and a bare year", () => {
    expect(parseDate("2024-02-30")).toBeNull();
    expect(parseDate("13/13/2024")).toBeNull();
    expect(parseDate("2024")).toBeNull();
    expect(cellKind("2024")).toBe("number");
  });
});

describe("inferColumn", () => {
  it("types plain numbers, with placeholders ignored", () => {
    expect(inferColumn(["1", "2,000", "(3)", "-", "n/a", "N/A", "", null])).toEqual({ type: "number", unit: null });
    expect(isPlaceholder("NA")).toBe(true);
    expect(isPlaceholder("..")).toBe(true);
  });

  it("reads a whole column as European only when every value is", () => {
    expect(inferColumnReading(["1.234,50", "2.000,00", "12,5"])).toMatchObject({ type: "number", european: true });
    expect(parseCell("1.234,50", "number", { european: true })).toBe(1234.5);
    expect(inferColumnReading(["1.234,50", "2000"]).european).toBe(false);
    // Three decimals alone are decimals, not dot thousands.
    expect(inferColumnReading(["1.250", "3.750"]).european).toBe(false);
  });

  it("types percent and currency with units", () => {
    expect(inferColumn(["12%", "3.5 %", "-1%"])).toEqual({ type: "percent", unit: "%" });
    expect(inferColumn(["$1,200", "$300.50", "€20"])).toEqual({ type: "currency", unit: "$" });
    expect(inferColumn(["1,200 €", "300 €"])).toEqual({ type: "currency", unit: "€" });
    expect(inferColumn(["USD 1,200", "USD 300", "250 USD"])).toEqual({ type: "currency", unit: "USD" });
    expect(inferColumn(["R$ 10", "R$ 20"])).toEqual({ type: "currency", unit: "R$" });
    expect(inferColumn(["CHF 10", "20 CHF"])).toEqual({ type: "currency", unit: "CHF" });
    expect(inferColumn(["(£1,000)", "£250"])).toEqual({ type: "currency", unit: "£" });
  });

  it("lets currency win when half carry a marker and the rest are numbers", () => {
    expect(inferColumn(["$10", "$20", "30", "40"])).toEqual({ type: "currency", unit: "$" });
    expect(inferColumn(["$10", "20", "30", "40"])).toEqual({ type: "number", unit: null });
    expect(inferColumn(["$10", "$20", "thirty", "forty"])).toEqual({ type: "text", unit: null });
  });

  it("types dates, deciding day-month order per column", () => {
    expect(inferColumn(["2024-01-05", "2024-02-06"])).toEqual({ type: "date", unit: null });
    const us = inferColumnReading(["1/5/2024", "2/6/2024"]);
    expect(us).toMatchObject({ type: "date", dayFirst: false });
    expect(parseCell("1/5/2024", "date", us)).toBe("2024-01-05");
    const eu = inferColumnReading(["1/5/2024", "25/6/2024"]);
    expect(eu).toMatchObject({ type: "date", dayFirst: true });
    expect(parseCell("1/5/2024", "date", eu)).toBe("2024-05-01");
    expect(inferColumn(["5 Jan 2024", "Jan 6, 2024", "March 2024"])).toEqual({ type: "date", unit: null });
  });

  it("keeps a column of years numeric, and mixed or empty columns text", () => {
    expect(inferColumn(["2021", "2022", "2023"])).toEqual({ type: "number", unit: null });
    expect(inferColumn(["1", "two", "3", "four"])).toEqual({ type: "text", unit: null });
    expect(inferColumn(["-", "", null])).toEqual({ type: "text", unit: null });
  });
});

describe("parseCell", () => {
  it("returns numbers, ISO dates and text", () => {
    expect(parseCell("12%", "percent")).toBe(12);
    expect(parseCell("$1,234.50", "currency")).toBe(1234.5);
    expect(parseCell("(1,000)", "number")).toBe(-1000);
    expect(parseCell("n/a", "number")).toBeNull();
    expect(parseCell("abc", "number")).toBeNull();
    expect(parseCell("Jan 5, 2024", "date")).toBe("2024-01-05");
    expect(parseCell("soon", "date")).toBeNull();
    expect(parseCell("  hello ", "text")).toBe("hello");
    expect(parseCell(null, "text")).toBe("");
  });
});

describe("detectHeader", () => {
  it("finds a plain header over typed columns", () => {
    const h = detectHeader([
      ["Region", "Revenue", "Share"],
      ["North", "$1,200", "12%"],
      ["South", "$900", "9%"],
    ]);
    expect(h).toMatchObject({ header_rows: 1, labels: ["Region", "Revenue", "Share"], title: null });
  });

  it("finds a header over text columns when its values don't repeat below", () => {
    const h = detectHeader([
      ["Name", "City"],
      ["Ann", "Leeds"],
      ["Bo", "York"],
    ]);
    expect(h.header_rows).toBe(1);
  });

  it("reads month and date labels over numeric columns as a header", () => {
    for (const months of [["Jan 2024", "Feb 2024"], ["2024-01", "2024-02"], ["2024-01-31", "2024-02-29"]]) {
      const h = detectHeader([
        ["Region", ...months],
        ["North", "10", "20"],
        ["South", "30", "40"],
      ]);
      expect(h).toMatchObject({ header_rows: 1, labels: ["Region", ...months] });
    }
  });

  it("reads years or months over a blank corner above the row labels as a header", () => {
    for (const periods of [["2022", "2023"], ["Jan 2024", "Feb 2024"]]) {
      const h = detectHeader([
        ["", ...periods],
        ["Revenue", "1", "2"],
        ["Cost", "3", "4"],
      ]);
      expect(h).toMatchObject({ header_rows: 1, labels: ["Column 1", ...periods] });
      expect(h.rows.slice(1)).toEqual([["Revenue", "1", "2"], ["Cost", "3", "4"]]);
    }
  });

  it("sees no header in a row of plain numbers beside a blank corner", () => {
    const h = detectHeader([
      ["", "5", "6"],
      ["Revenue", "1", "2"],
      ["Cost", "3", "4"],
    ]);
    expect(h.header_rows).toBe(0);
  });

  it("keeps a first data row whose dates sit over a date column", () => {
    const h = detectHeader([
      ["Ann", "2024-01-01", "10"],
      ["Bo", "2024-01-02", "20"],
      ["Cy", "2024-01-03", "30"],
    ]);
    expect(h.header_rows).toBe(0);
  });

  it("sees no header when the first row is numbers", () => {
    const h = detectHeader([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
    expect(h).toMatchObject({ header_rows: 0, labels: ["Column 1", "Column 2", "Column 3"] });
  });

  it("reads a two-row header written with spanning blanks", () => {
    const h = detectHeader([
      ["", "Revenue", "", "Costs", ""],
      ["Region", "Q1", "Q2", "Q1", "Q2"],
      ["North", "1", "2", "3", "4"],
      ["South", "5", "6", "7", "8"],
      ["East", "5", "6", "7", "8"],
      ["West", "5", "6", "7", "8"],
      ["Mid", "5", "6", "7", "8"],
    ]);
    expect(h.header_rows).toBe(2);
    expect(h.labels).toEqual(["Region", "Revenue · Q1", "Revenue · Q2", "Costs · Q1", "Costs · Q2"]);
  });

  it("reads a two-row header with merged cells already filled", () => {
    const h = detectHeader([
      ["Region", "Revenue", "Revenue"],
      ["", "Q1", "Q2"],
      ["North", "1", "2"],
      ["South", "3", "4"],
    ]);
    expect(h.header_rows).toBe(2);
    expect(h.labels).toEqual(["Region", "Revenue · Q1", "Revenue · Q2"]);
  });

  it("treats years in a header row as labels", () => {
    const h = detectHeader([
      ["Region", "2023", "2024"],
      ["North", "1", "2"],
      ["South", "3", "4"],
    ]);
    expect(h).toMatchObject({ header_rows: 1, labels: ["Region", "2023", "2024"] });
  });

  it("takes off a title row, and empty edges and columns", () => {
    const h = detectHeader([
      ["", "", "", ""],
      ["Budget 2024", "", "", ""],
      ["Item", "", "Cost", ""],
      ["Paper", "", "$5", ""],
      ["Ink", "", "$9", ""],
      ["", "", "", ""],
    ]);
    expect(h.title).toBe("Budget 2024");
    expect(h.columnMap).toEqual([0, 2]);
    expect(h).toMatchObject({ header_rows: 1, labels: ["Item", "Cost"] });
    expect(h.rows).toEqual([["Item", "Cost"], ["Paper", "$5"], ["Ink", "$9"]]);
  });

  it("names blank labels and numbers duplicates", () => {
    const h = detectHeader([
      ["Name", "", "Score", "Score", "x"],
      ["Ann", "a", "1", "2", "y"],
      ["Bo", "b", "3", "4", "z"],
    ]);
    expect(h.labels).toEqual(["Name", "Column 2", "Score", "Score (2)", "x"]);
  });

  it("doesn't read a placeholder data row as a second header row", () => {
    const h = detectHeader([
      ["Name", "Amount"],
      ["Ann", "n/a"],
      ["Bo", "3"],
      ["Cy", "4"],
      ["Di", "5"],
      ["Ed", "6"],
    ]);
    expect(h.header_rows).toBe(1);
  });

  it("uses a known header row count without detection", () => {
    const h = detectHeader(
      [
        ["Item", ""],
        ["1", "2"],
      ],
      1,
    );
    expect(h).toMatchObject({ header_rows: 1, labels: ["Item", "Column 2"], title: null });
  });
});
