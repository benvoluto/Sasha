import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  del: vi.fn(),
  upload: vi.fn(),
  split: vi.fn(),
}));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: mocks.generate };
    files = { get: vi.fn(async () => ({ state: "ACTIVE" })), delete: mocks.del };
  },
}));
vi.mock("@/lib/gemini-url-upload", () => ({ uploadBytesToGemini: mocks.upload }));
vi.mock("@/lib/pdf-chunks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdf-chunks")>()),
  splitPdf: mocks.split,
}));

import { withModelContext } from "@/lib/llm/context";
import { readMemoryAudit, resetMemoryAudit } from "@/lib/ontology/governance";
import { GeminiTablesReply, LOW_CONFIDENCE_NOTE, NOT_CONFIGURED, PAGES_CAPPED, parseJsonText, readGeminiTables, repairTables, TABLES_FAILED } from "./gemini-tables";

const PDF = { name: "report.pdf", mime: "application/pdf" };
const chunk = (first: number, last: number) => ({ first, last, bytes: Buffer.from(`pages ${first}-${last}`) });
const reply = (json: unknown, finishReason = "STOP", fence = false) => {
  const text = JSON.stringify(json);
  return { text: fence ? "```json\n" + text + "\n```" : text, candidates: [{ finishReason }] };
};
const table = (over: Partial<GeminiTablesReply["tables"][number]> = {}) => ({
  title: "Budget",
  page: 2,
  page_end: null,
  columns: ["Item", "Cost"],
  rows: [["Paper", "$5"], ["Ink", "$9"]],
  confidence: 0.9,
  notes: "",
  ...over,
});
/** The prompt text of a generateContent call. */
const promptOf = (call: unknown[]) => JSON.stringify((call[0] as { contents: unknown }).contents);
const isCheck = (call: unknown[]) => promptOf(call).includes("report which pages contain a data table");

describe("readGeminiTables", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.upload.mockImplementation(async (bytes: Buffer) => ({ ok: true, file: { uri: `uri:${bytes.toString()}`, mimeType: "application/pdf", name: `files/${bytes.toString()}` } }));
    mocks.del.mockResolvedValue({});
    mocks.split.mockResolvedValue([chunk(1, 3)]);
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it("checks for tables, then extracts only the pages that have them", async () => {
    mocks.generate.mockImplementation(async (req) => (isCheck([req]) ? reply({ pages: [2, 9] }) : reply({ tables: [table()] })));
    const out = await readGeminiTables(Buffer.from("%PDF"), PDF);
    expect(out).toMatchObject({ ok: true, warnings: [] });
    if (!out.ok) return;
    expect(out.grids).toHaveLength(1);
    expect(out.grids[0]).toMatchObject({ name: "Budget", match_key: "page:2#1", header_rows: 1, method: "gemini-pdf", page: 2, page_end: null, confidence: 0.9 });
    expect(out.grids[0].cells).toEqual([["Item", "Cost"], ["Paper", "$5"], ["Ink", "$9"]]);
    const [check, extract] = mocks.generate.mock.calls;
    expect(check[0].config).toMatchObject({ temperature: 0, maxOutputTokens: 256, responseMimeType: "application/json" });
    expect(check[0].config.responseJsonSchema).toMatchObject({ type: "object", properties: { pages: { type: "array" } } });
    expect(check[0].config.responseJsonSchema).not.toHaveProperty("$schema");
    // Page 9 is outside the chunk and dropped.
    expect(promptOf(extract)).toContain("Extract every data table on pages 2 of this file");
    expect(extract[0].config).toMatchObject({ temperature: 0, maxOutputTokens: 65536, responseMimeType: "application/json" });
    expect(mocks.del).toHaveBeenCalledWith({ name: "files/pages 1-3" });
  });

  it("audits each generateContent call as gemini.tables with its usage and the caller's context", async () => {
    resetMemoryAudit();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 5, cachedContentTokenCount: 10 };
    mocks.generate.mockImplementation(async (req) => ({ ...(isCheck([req]) ? reply({ pages: [2] }) : reply({ tables: [table()] })), usageMetadata }));
    await withModelContext({ teamId: "org:a", userId: "u1", agent: "ann", documentId: "d1" }, () => readGeminiTables(Buffer.from("%PDF"), PDF));
    const rows = readMemoryAudit().filter((e) => e.action === "llm:gemini.tables");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      task: "gemini.tables",
      teamId: "org:a",
      userId: "u1",
      documentId: "d1",
      allowed: true,
      result: { input_tokens: 990, output_tokens: 55, cache_read_input_tokens: 10 },
    });
    vi.restoreAllMocks();
  });

  it("skips a chunk the check says has no tables", async () => {
    mocks.split.mockResolvedValue([chunk(1, 10), chunk(11, 20)]);
    mocks.generate.mockImplementation(async (req) => {
      if (isCheck([req])) return reply({ pages: promptOf([req]).includes("pages 1–10") ? [] : [12] });
      return reply({ tables: [table({ page: 12 })] });
    });
    const out = await readGeminiTables(Buffer.from("%PDF"), PDF);
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    expect(out.ok && out.grids.map((g) => g.match_key)).toEqual(["page:12#1"]);
  });

  it("extracts anyway when the check fails", async () => {
    mocks.generate.mockImplementation(async (req) => (isCheck([req]) ? reply({ pages: "two" }) : reply({ tables: [table()] })));
    const out = await readGeminiTables(Buffer.from("%PDF"), PDF);
    expect(out.ok && out.grids).toHaveLength(1);
    expect(promptOf(mocks.generate.mock.calls[1])).toContain("pages 1–3 of this file");
  });

  it("fails a chunk whose reply stopped at MAX_TOKENS", async () => {
    mocks.generate.mockImplementation(async (req) => (isCheck([req]) ? reply({ pages: [2] }) : reply({ tables: [table()] }, "MAX_TOKENS")));
    expect(await readGeminiTables(Buffer.from("%PDF"), PDF)).toEqual({ ok: false, reason: TABLES_FAILED });
  });

  it("strips a code fence", async () => {
    mocks.generate.mockImplementation(async (req) => (isCheck([req]) ? reply({ pages: [2] }, "STOP", true) : reply({ tables: [table()] }, "STOP", true)));
    const out = await readGeminiTables(Buffer.from("%PDF"), PDF);
    expect(out.ok && out.grids).toHaveLength(1);
    expect(parseJsonText('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("fails a chunk whose reply doesn't match the schema", async () => {
    mocks.generate.mockImplementation(async (req) => (isCheck([req]) ? reply({ pages: [2] }) : reply({ tables: [{ title: "x", rows: 3 }] })));
    expect(await readGeminiTables(Buffer.from("%PDF"), PDF)).toEqual({ ok: false, reason: TABLES_FAILED });
  });

  it("warns per failed chunk when others succeed", async () => {
    mocks.split.mockResolvedValue([chunk(1, 10), chunk(11, 20)]);
    mocks.generate.mockImplementation(async (req) => {
      if (isCheck([req])) return reply({ pages: promptOf([req]).includes("pages 1–10") ? [3] : [12] });
      if (promptOf([req]).includes("pages 12")) throw new Error("400 INVALID_ARGUMENT");
      return reply({ tables: [table({ page: 3 })] });
    });
    const out = await readGeminiTables(Buffer.from("%PDF"), PDF);
    expect(out).toMatchObject({ ok: true, warnings: ["Pages 11–20: tables couldn't be read."], unread: [{ first: 11, last: 20 }] });
    expect(out.ok && out.grids).toHaveLength(1);
  });

  it("is not ok when every chunk fails, or the upload does", async () => {
    mocks.split.mockResolvedValue([chunk(1, 10), chunk(11, 20)]);
    mocks.upload.mockResolvedValue({ ok: false, reason: "upload refused" });
    expect(await readGeminiTables(Buffer.from("%PDF"), PDF)).toEqual({ ok: false, reason: TABLES_FAILED });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("checks only the first 100 pages", async () => {
    mocks.split.mockResolvedValue(Array.from({ length: 12 }, (_, i) => chunk(i * 10 + 1, i * 10 + 10)));
    mocks.generate.mockImplementation(async () => reply({ pages: [] }));
    const out = await readGeminiTables(Buffer.from("%PDF"), PDF);
    expect(out).toEqual({ ok: true, grids: [], unread: [{ first: 101, last: null }], warnings: [PAGES_CAPPED], dropped: [] });
    expect(mocks.upload).toHaveBeenCalledTimes(10);
  });

  it("says when table reading isn't configured", async () => {
    delete process.env.GEMINI_API_KEY;
    expect(await readGeminiTables(Buffer.from("%PDF"), PDF)).toEqual({ ok: false, reason: NOT_CONFIGURED });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("reads an image whole, without the check", async () => {
    mocks.generate.mockResolvedValue(reply({ tables: [table({ page: 1 })] }));
    const out = await readGeminiTables(Buffer.from("png"), { name: "scan.png", mime: "image/png" });
    expect(mocks.split).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(isCheck(mocks.generate.mock.calls[0])).toBe(false);
    expect(out.ok && out.grids[0]).toMatchObject({ method: "gemini-image", page: null, page_end: null, match_key: "page:1#1" });
  });

  it("stops at the deadline: no extraction after a slow check, calls aborted, no retry", async () => {
    const deadline = Date.now() + 80;
    const signals: Array<AbortSignal | undefined> = [];
    mocks.generate.mockImplementation(async (req) => {
      signals.push(req.config.abortSignal);
      // The check runs past the deadline.
      await new Promise((r) => setTimeout(r, 120));
      return reply({ pages: [2] });
    });
    expect(await readGeminiTables(Buffer.from("%PDF"), PDF, { deadline })).toEqual({ ok: false, reason: TABLES_FAILED });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    // The uploaded chunk is still cleaned up.
    expect(mocks.del).toHaveBeenCalledTimes(1);

    mocks.generate.mockReset();
    mocks.generate.mockImplementation(async (req) => {
      if (isCheck([req])) return reply({ pages: [2] });
      throw new Error("503 UNAVAILABLE");
    });
    const started = Date.now();
    await readGeminiTables(Buffer.from("%PDF"), PDF, { deadline: Date.now() + 500 });
    // A transient failure isn't retried when the backoff would cross the deadline.
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("fails chunks once the deadline has passed", async () => {
    expect(await readGeminiTables(Buffer.from("%PDF"), PDF, { deadline: Date.now() - 1 })).toEqual({ ok: false, reason: TABLES_FAILED });
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe("repairTables", () => {
  it("evens out ragged rows and notes it", () => {
    const { grids } = repairTables({ tables: [table({ rows: [["a"], ["b", "c", "d"], [null, "e"]] })] }, { first: 1, last: 3 }, "gemini-pdf");
    expect(grids[0].cells).toEqual([["Item", "Cost"], ["a", ""], ["b", "c"], ["", "e"]]);
    expect(grids[0].notes).toEqual(["Some rows had missing or extra cells and were evened out."]);
  });

  it("clamps pages into the chunk and counts tables per page", () => {
    const { grids } = repairTables(
      { tables: [table({ page: 25, page_end: 40 }), table({ page: 3 }), table({ page: 14, page_end: 15 }), table({ page: 14 })] },
      { first: 11, last: 20 },
      "gemini-pdf",
    );
    expect(grids.map((g) => [g.page, g.page_end, g.match_key])).toEqual([
      [20, null, "page:20#1"],
      [11, null, "page:11#1"],
      [14, 15, "page:14#1"],
      [14, null, "page:14#2"],
    ]);
  });

  it("drops tables with one column or no rows, and notes low confidence and the model's notes", () => {
    const { grids, dropped } = repairTables(
      { tables: [table({ columns: ["Only"] }), table({ rows: [[null, " "]] }), table({ confidence: 0.4, notes: "Two cells unreadable." })] },
      { first: 1, last: 3 },
      "gemini-pdf",
    );
    expect(dropped.map((d) => d.reason)).toEqual(["fewer than 2 columns", "no rows"]);
    expect(grids).toHaveLength(1);
    expect(grids[0].notes).toEqual(["Two cells unreadable.", LOW_CONFIDENCE_NOTE]);
  });

  it("cuts long cells", () => {
    const { grids } = repairTables({ tables: [table({ rows: [["x".repeat(2000), "y"]] })] }, { first: 1, last: 1 }, "gemini-pdf");
    expect(grids[0].cells[1][0]).toHaveLength(1000);
  });
});
