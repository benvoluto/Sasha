// Contract test over real Gemini table replies, recorded from the live test
// (SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1 npx vitest run src/lib/data/gemini-tables.live.test.ts).
// Pins the shape the model actually returns: it parses with the schemas sent
// to the model and survives repair and buildTable intact. The hand-written
// edge cases live in __fixtures__/gemini-tables.edge-cases.json.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tablesFromGrids } from "./extract";
import { GeminiTablesReply, LOW_CONFIDENCE_NOTE, pagesInChunk, repairTables, TablePages } from "./gemini-tables";

type Chunk = { first: number; last: number | null };
const load = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

const recorded = load("gemini-tables.recorded.json") as { replies: Array<{ call: "check" | "extract"; chunk: Chunk; data: unknown }> };
const edge = load("gemini-tables.edge-cases.json") as {
  cases: Array<{
    name: string;
    chunk: Chunk;
    data: unknown;
    expect: { tables: number; dropped?: string[]; match_keys: string[]; pages: Array<[number, number | null]>; labels: string[][]; types: string[][]; rows: number[]; names?: string[]; low_confidence?: boolean[] };
  }>;
};

describe("Gemini tables recorded replies", () => {
  it("parses the presence check and keeps the table's page", () => {
    const check = recorded.replies.find((r) => r.call === "check")!;
    expect(pagesInChunk(TablePages.parse(check.data), check.chunk)).toEqual([2]);
  });

  it("parses the extraction and builds a typed table from it", () => {
    const reply = recorded.replies.find((r) => r.call === "extract")!;
    const { grids, dropped } = repairTables(GeminiTablesReply.parse(reply.data), reply.chunk, "gemini-pdf");
    expect(dropped).toEqual([]);
    const { tables } = tablesFromGrids(grids);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t).toMatchObject({ page: 2, match_key: "page:2#1", extraction_method: "gemini-pdf" });
    expect(t.columns.map((c) => c.label)).toEqual(["Region", "Q1 revenue", "Q2 revenue", "Growth"]);
    expect(t.columns.map((c) => c.type)).toEqual(["text", "currency", "currency", "percent"]);
    expect(t.columns[1].unit).toBe("$");
    expect(t.rows).toHaveLength(4);
    // Cells are trimmed, otherwise exactly as printed.
    expect(t.rows[1]).toEqual(["South", "$9,800", "$9,310", "(5.0%)"]);
  });
});

describe("Gemini tables edge cases", () => {
  for (const c of edge.cases) {
    it(c.name, () => {
      const { grids, dropped } = repairTables(GeminiTablesReply.parse(c.data), c.chunk, "gemini-pdf");
      expect(dropped.map((d) => d.reason)).toEqual(c.expect.dropped ?? []);
      const { tables } = tablesFromGrids(grids);
      expect(tables).toHaveLength(c.expect.tables);
      expect(tables.map((t) => t.match_key)).toEqual(c.expect.match_keys);
      expect(tables.map((t) => [t.page, t.page_end])).toEqual(c.expect.pages);
      expect(tables.map((t) => t.columns.map((col) => col.label))).toEqual(c.expect.labels);
      expect(tables.map((t) => t.columns.map((col) => col.type))).toEqual(c.expect.types);
      expect(tables.map((t) => t.rows.length)).toEqual(c.expect.rows);
      if (c.expect.names) expect(tables.map((t) => t.name)).toEqual(c.expect.names);
      if (c.expect.low_confidence) expect(tables.map((t) => t.notes.includes(LOW_CONFIDENCE_NOTE))).toEqual(c.expect.low_confidence);
    });
  }
});
