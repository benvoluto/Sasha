import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gemini: vi.fn(),
  download: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  summarize: vi.fn(),
  fetchUrl: vi.fn(),
  replaceTables: vi.fn(),
  geminiTables: vi.fn(),
}));
vi.mock("@/lib/gemini", () => ({ processDocumentsWithGemini: mocks.gemini }));
vi.mock("@/lib/blob-download", () => ({ downloadBlobContent: mocks.download }));
vi.mock("@vercel/blob", () => ({ put: mocks.put, del: mocks.del, list: vi.fn() }));
vi.mock("./summarize", () => ({ summarizeSource: mocks.summarize }));
vi.mock("@/lib/data/store", () => ({ replaceSourceTables: mocks.replaceTables }));
vi.mock("@/lib/data/extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/extract")>()),
  extractGeminiTables: mocks.geminiTables,
}));
vi.mock("./url-extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./url-extract")>()),
  fetchUrlSource: mocks.fetchUrl,
}));

import * as XLSX from "xlsx";
import type { ExtractedTable } from "@/lib/data/contract";
import { CFB_MESSAGE } from "@/lib/data/zip-guard";
import { resetMemoryStore } from "@/lib/documents/store";
import { LINKED_PDF_ADVICE, UPLOAD_ADVICE } from "@/lib/extracted-text";
import { EXTRACTION_BUDGET_MS, INGEST_BUDGET_MS, ingestSource, TABLES_NOT_SAVED, TABLES_SKIPPED } from "./ingest";
import { createSource, deleteSource, getSource, listPassages, resetSourceStore, setSourceFile } from "./store";
import { UrlSourceError } from "./url-extract";

const T = "org:a";
const BLOB = "https://abc.public.blob.vercel-storage.com/sources/x/file.pdf";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_TEXT = { status: "success", extractedContent: "=== Document: report.pdf ===\n--- Page 1 ---\nThe plan was approved.", processedAt: "", fileCount: 1 };

function xlsxBytes(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const geminiTable = (name: string): ExtractedTable => ({
  match_key: "page:2#1",
  name,
  columns: [
    { key: "c1", label: "Item", type: "text", inferred: "text", unit: null },
    { key: "c2", label: "Cost", type: "currency", inferred: "currency", unit: "$" },
  ],
  rows: [["Paper", "$5"]],
  extraction_method: "gemini-pdf",
  sheet: null,
  page: 2,
  page_end: null,
  confidence: 0.9,
  notes: "",
  truncated: false,
});

async function fileSource(mime: string, filename: string) {
  const s = await createSource(T, "ann", { kind: "file", filename, mime });
  await setSourceFile(T, s.id, { blob_url: BLOB, blob_pathname: "sources/x/file.pdf", bytes: 10, mime, status: "pending" });
  return s;
}

/** Records the source's status whenever a mocked step runs. */
function statusAt(id: string, seen: string[]) {
  return async () => {
    seen.push((await getSource(T, id))!.extraction_status);
  };
}

describe("ingestSource", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.summarize.mockResolvedValue({ summary: "A short summary.", title: "Suggested title" });
    mocks.replaceTables.mockResolvedValue({ inserted: 0, superseded: 0 });
    mocks.geminiTables.mockResolvedValue({ ok: true, tables: [], warnings: [] });
  });

  it("reads a file with Gemini: extracting → summarizing → ready, with passages and summary", async () => {
    const s = await fileSource("application/pdf", "report.pdf");
    const seen: string[] = [];
    mocks.gemini.mockImplementation(async (files) => {
      await statusAt(s.id, seen)();
      expect(files).toEqual([{ url: BLOB, name: "report.pdf", type: "application/pdf" }]);
      return { status: "success", extractedContent: "=== Document: report.pdf ===\n--- Page 1 ---\nThe plan was approved.", processedAt: "", fileCount: 1 };
    });
    mocks.summarize.mockImplementation(async () => {
      await statusAt(s.id, seen)();
      return { summary: "A short summary.", title: "Approved plan" };
    });

    await ingestSource(T, s.id, "ann");

    expect(seen).toEqual(["extracting", "summarizing"]);
    const after = await getSource(T, s.id);
    expect(after).toMatchObject({ extraction_status: "ready", extraction_error: null, summary: "A short summary.", title: "Approved plan" });
    expect(after?.extracted_text).toContain("The plan was approved.");
    const passages = await listPassages(T, s.id);
    expect(passages).toHaveLength(1);
    expect(passages![0]).toMatchObject({ page: 1, text: "The plan was approved." });
    expect(passages![0].id).toMatch(/^S[0-9a-f]{8}\.P0$/);
  });

  it("reads text files directly, without Gemini", async () => {
    const s = await fileSource("text/markdown", "notes.md");
    mocks.download.mockResolvedValue(Buffer.from("﻿# Notes\n\nThe budget is final."));
    await ingestSource(T, s.id, "ann");
    expect(mocks.gemini).not.toHaveBeenCalled();
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", extracted_text: "# Notes\n\nThe budget is final." });
  });

  it("decodes a UTF-16 or windows-1252 CSV the same way for its text and its table", async () => {
    const utf16 = await fileSource("text/csv", "wide.csv");
    mocks.download.mockResolvedValue(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Name,Amount\nAnn,12\n", "utf16le")]));
    await ingestSource(T, utf16.id, "ann");
    const a = await getSource(T, utf16.id);
    expect(a).toMatchObject({ extraction_status: "ready", extracted_text: "Name,Amount\nAnn,12\n" });
    expect(a!.extracted_text).not.toContain("\u0000");
    expect(mocks.replaceTables.mock.calls[0][3][0]).toMatchObject({ rows: [["Ann", "12"]] });

    const cp1252 = await fileSource("text/csv", "cafe.csv");
    mocks.download.mockResolvedValue(Buffer.from([...Buffer.from("Shop,Price\nCaf"), 0xe9, 0x2c, 0x80, ...Buffer.from("5\n")]));
    await ingestSource(T, cp1252.id, "ann");
    expect((await getSource(T, cp1252.id))!.extracted_text).toBe("Shop,Price\nCafé,€5\n");
    expect(mocks.replaceTables.mock.calls[1][3][0]).toMatchObject({ rows: [["Café", "€5"]] });
  });

  it("reads a CSV as text and as one table, from one download", async () => {
    const s = await fileSource("text/csv", "people.csv");
    mocks.download.mockResolvedValue(Buffer.from("Name,Amount\nAnn,12\nBo,30\n"));
    const seen: string[] = [];
    mocks.replaceTables.mockImplementation(async () => {
      await statusAt(s.id, seen)();
      return { inserted: 1, superseded: 0 };
    });
    await ingestSource(T, s.id, "ann");
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", extraction_error: null, extracted_text: "Name,Amount\nAnn,12\nBo,30\n" });
    const [team, id, agent, tables] = mocks.replaceTables.mock.calls[0];
    expect([team, id, agent]).toEqual([T, s.id, "ann"]);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ name: "people", match_key: "csv", rows: [["Ann", "12"], ["Bo", "30"]] });
    // Written before the terminal status.
    expect(seen).toEqual(["summarizing"]);
    expect(mocks.geminiTables).not.toHaveBeenCalled();
  });

  it("reads an XLSX into text, passages, a summary and tables", async () => {
    const s = await fileSource(XLSX_MIME, "budget.xlsx");
    mocks.download.mockResolvedValue(xlsxBytes({ Costs: [["Item", "Cost"], ["Paper", 5], ["Ink", 9]], Staff: [["Name", "Role"], ["Ann", "Lead"]] }));
    await ingestSource(T, s.id, "ann");
    expect(mocks.gemini).not.toHaveBeenCalled();
    const after = await getSource(T, s.id);
    expect(after).toMatchObject({ extraction_status: "ready", extraction_error: null, summary: "A short summary." });
    expect(after?.extracted_text).toBe("## Costs\nItem\tCost\nPaper\t5\nInk\t9\n\n## Staff\nName\tRole\nAnn\tLead");
    expect((await listPassages(T, s.id))!.length).toBeGreaterThan(0);
    expect(mocks.summarize).toHaveBeenCalledWith(expect.objectContaining({ text: after?.extracted_text }));
    expect(mocks.replaceTables.mock.calls[0][3].map((t: ExtractedTable) => t.match_key)).toEqual(["sheet:Costs", "sheet:Staff"]);
  });

  it("errors on an XLSX that can't be read, keeping the earlier tables", async () => {
    const s = await fileSource(XLSX_MIME, "locked.xlsx");
    mocks.download.mockResolvedValue(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, ...new Array(64).fill(0)]));
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error", extraction_error: CFB_MESSAGE });
    expect(mocks.replaceTables).not.toHaveBeenCalled();
  });

  it("runs the Gemini table pass for an uploaded PDF and stores its tables before the terminal status", async () => {
    const s = await fileSource("application/pdf", "report.pdf");
    mocks.gemini.mockResolvedValue(PDF_TEXT);
    mocks.download.mockResolvedValue(Buffer.from("%PDF-1.7"));
    mocks.geminiTables.mockResolvedValue({ ok: true, tables: [geminiTable("Budget")], warnings: [] });
    const seen: string[] = [];
    mocks.replaceTables.mockImplementation(async () => {
      await statusAt(s.id, seen)();
      return { inserted: 1, superseded: 0 };
    });
    await ingestSource(T, s.id, "ann");
    expect(mocks.geminiTables.mock.calls[0][0]).toEqual(Buffer.from("%PDF-1.7"));
    expect(mocks.geminiTables.mock.calls[0][1]).toEqual({ name: "report.pdf", mime: "application/pdf" });
    expect(mocks.geminiTables.mock.calls[0][2].deadline).toBeGreaterThan(Date.now());
    expect(mocks.replaceTables.mock.calls[0][3]).toEqual([geminiTable("Budget")]);
    expect(seen).toEqual(["summarizing"]);
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", extraction_error: null, summary: "A short summary." });
  });

  it("keeps the earlier tables and ends partial when the PDF table pass fails", async () => {
    const s = await fileSource("application/pdf", "report.pdf");
    mocks.gemini.mockResolvedValue({ ...PDF_TEXT, status: "partial", error: "Page 2 was blank." });
    mocks.download.mockResolvedValue(Buffer.from("%PDF"));
    mocks.geminiTables.mockResolvedValue({ ok: false, reason: "Tables in this file couldn't be read. Read it again to try." });
    await ingestSource(T, s.id, "ann");
    expect(mocks.replaceTables).not.toHaveBeenCalled();
    expect(await getSource(T, s.id)).toMatchObject({
      extraction_status: "partial",
      extraction_error: "Page 2 was blank. Tables in this file couldn't be read. Read it again to try.",
      summary: "A short summary.",
    });
  });

  it("ends partial with the pass's warnings when some pages failed", async () => {
    const s = await fileSource("application/pdf", "report.pdf");
    mocks.gemini.mockResolvedValue(PDF_TEXT);
    mocks.download.mockResolvedValue(Buffer.from("%PDF"));
    const unread = [{ first: 11, last: 20 }];
    mocks.geminiTables.mockResolvedValue({ ok: true, tables: [geminiTable("Budget")], warnings: ["Pages 11–20: tables couldn't be read."], unread });
    await ingestSource(T, s.id, "ann");
    expect(mocks.replaceTables).toHaveBeenCalledTimes(1);
    // The tables on the pages that failed are kept, not retired.
    expect(mocks.replaceTables.mock.calls[0][4]).toEqual({ keepPages: unread });
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "partial", extraction_error: "Pages 11–20: tables couldn't be read." });
  });

  it("ends partial when the table pass throws or storing tables fails", async () => {
    const s = await fileSource("image/png", "scan.png");
    mocks.gemini.mockResolvedValue(PDF_TEXT);
    mocks.download.mockRejectedValue(new Error("blob gone"));
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "partial", extraction_error: "Tables in this file couldn't be read. Read it again to try." });

    mocks.download.mockResolvedValue(Buffer.from("png"));
    mocks.replaceTables.mockRejectedValue(new Error("db down"));
    await expect(ingestSource(T, s.id, "ann")).resolves.toBeUndefined();
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "partial", extraction_error: TABLES_NOT_SAVED });
  });

  it("stores each re-read's tables, so a retry supersedes the earlier ones", async () => {
    const s = await fileSource("application/pdf", "report.pdf");
    mocks.gemini.mockResolvedValue(PDF_TEXT);
    mocks.download.mockResolvedValue(Buffer.from("%PDF"));
    mocks.geminiTables.mockResolvedValueOnce({ ok: true, tables: [geminiTable("First")], warnings: [] });
    mocks.geminiTables.mockResolvedValueOnce({ ok: true, tables: [geminiTable("Second")], warnings: [] });
    await ingestSource(T, s.id, "ann");
    await ingestSource(T, s.id, "bob");
    expect(mocks.replaceTables.mock.calls.map((c) => [c[2], c[3][0].name])).toEqual([
      ["ann", "First"],
      ["bob", "Second"],
    ]);
  });

  it("runs one read when two start on the same source at once", async () => {
    const s = await fileSource("text/csv", "people.csv");
    mocks.download.mockResolvedValue(Buffer.from("Name,Amount\nAnn,12\n"));
    await Promise.all([ingestSource(T, s.id, "ann"), ingestSource(T, s.id, "bob")]);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.replaceTables).toHaveBeenCalledTimes(1);
    expect((await getSource(T, s.id))?.extraction_status).toBe("ready");
  });

  it("skips the table pass with a warning when too little time is left", async () => {
    const s = await fileSource("application/pdf", "late.pdf");
    // The read itself is quick, but the clock says it finished 15s before the budget runs out.
    const realNow = Date.now;
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      mocks.gemini.mockImplementation(async () => {
        offset = INGEST_BUDGET_MS - 15_000;
        return PDF_TEXT;
      });
      await ingestSource(T, s.id, "ann");
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(mocks.geminiTables).not.toHaveBeenCalled();
    expect(mocks.replaceTables).not.toHaveBeenCalled();
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "partial", extraction_error: TABLES_SKIPPED });
  });

  it("runs no table pass for Word files or links", async () => {
    const docx = await fileSource("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx");
    mocks.gemini.mockResolvedValue(PDF_TEXT);
    await ingestSource(T, docx.id, "ann");
    const link = await createSource(T, "ann", { kind: "url", url: "https://example.org/r.pdf" });
    mocks.put.mockResolvedValue({ url: "https://abc.public.blob.vercel-storage.com/sources/h/id/r-xyz.pdf", pathname: "sources/h/id/r-xyz.pdf" });
    mocks.fetchUrl.mockImplementation(async (_url, opts) => ({ title: null, text: await opts.onPdf(Buffer.from("%PDF"), new URL("https://example.org/r.pdf")), finalUrl: "", contentType: "application/pdf" }));
    await ingestSource(T, link.id, "ann");
    expect(mocks.geminiTables).not.toHaveBeenCalled();
    expect(mocks.replaceTables).not.toHaveBeenCalled();
    expect(await getSource(T, link.id)).toMatchObject({ extraction_status: "ready" });
  });

  it("records a Gemini error with its message", async () => {
    const s = await fileSource("application/pdf", "scan.pdf");
    mocks.gemini.mockResolvedValue({ status: "error", extractedContent: "", error: "No readable text was found in scan.pdf.", processedAt: "", fileCount: 0 });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error", extraction_error: "No readable text was found in scan.pdf." });
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect(await listPassages(T, s.id)).toEqual([]);
  });

  it("keeps partial text and its warning", async () => {
    const s = await fileSource("application/pdf", "two.pdf");
    mocks.gemini.mockResolvedValue({ status: "partial", extractedContent: "--- Page 1 ---\nSome text here.", error: "Page 2 was blank.", processedAt: "", fileCount: 1 });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "partial", extraction_error: "Page 2 was blank.", summary: "A short summary." });
  });

  it("turns a thrown error into a friendly status and never throws", async () => {
    const s = await fileSource("application/pdf", "big.pdf");
    mocks.gemini.mockRejectedValue(new Error("socket hang up"));
    await expect(ingestSource(T, s.id, "ann")).resolves.toBeUndefined();
    const after = await getSource(T, s.id);
    expect(after?.extraction_status).toBe("error");
    expect(after?.extraction_error).toMatch(/socket hang up/);
  });

  it("errors on a file that never finished uploading", async () => {
    const s = await createSource(T, "ann", { kind: "file", filename: "a.pdf", mime: "application/pdf" });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error" });
    expect((await getSource(T, s.id))?.extraction_error).toMatch(/never finished uploading/);
  });

  it("skips a source that is still uploading", async () => {
    const s = await createSource(T, "ann", { kind: "file", filename: "a.pdf", mime: "application/pdf", extraction_status: "uploading" });
    await ingestSource(T, s.id, "ann");
    expect((await getSource(T, s.id))?.extraction_status).toBe("uploading");
  });

  it("reads a link and takes the page title when the source has none", async () => {
    const s = await createSource(T, "ann", { kind: "url", url: "https://example.org/a" });
    mocks.fetchUrl.mockResolvedValue({ title: "Page title", text: "Readable article text.", finalUrl: "https://example.org/a", contentType: "text/html" });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", title: "Page title", extracted_text: "Readable article text." });
  });

  it("stores a linked PDF and reads it with Gemini", async () => {
    const s = await createSource(T, "ann", { kind: "url", url: "https://example.org/r.pdf" });
    mocks.put.mockResolvedValue({ url: "https://abc.public.blob.vercel-storage.com/sources/h/id/r-xyz.pdf", pathname: "sources/h/id/r-xyz.pdf" });
    mocks.gemini.mockResolvedValue({ status: "success", extractedContent: "--- Page 1 ---\nPDF text.", processedAt: "", fileCount: 1 });
    mocks.fetchUrl.mockImplementation(async (_url, opts) => {
      const text = await opts.onPdf(Buffer.from("%PDF-1.7"), new URL("https://example.org/r.pdf"));
      return { title: "r.pdf", text, finalUrl: "https://example.org/r.pdf", contentType: "application/pdf" };
    });
    await ingestSource(T, s.id, "ann");
    expect(mocks.put.mock.calls[0][0]).toMatch(new RegExp(`^sources/[0-9a-f]{16}/${s.id}/r\\.pdf$`));
    // A private store (the default, BLOB_ACCESS unset) refuses public writes.
    expect(mocks.put.mock.calls[0][2]).toMatchObject({ access: "private", addRandomSuffix: true });
    expect(await getSource(T, s.id)).toMatchObject({
      extraction_status: "ready",
      blob_url: "https://abc.public.blob.vercel-storage.com/sources/h/id/r-xyz.pdf",
      mime: "application/pdf",
      filename: "r.pdf",
    });
  });

  it("gives a linked PDF that can't be read advice that fits a link", async () => {
    const s = await createSource(T, "ann", { kind: "url", url: "https://example.org/r.pdf" });
    mocks.put.mockResolvedValue({ url: "https://abc.public.blob.vercel-storage.com/sources/h/id/r-xyz.pdf", pathname: "sources/h/id/r-xyz.pdf" });
    mocks.fetchUrl.mockImplementation(async (_url, opts) => ({ title: null, text: await opts.onPdf(Buffer.from("%PDF"), new URL("https://example.org/r.pdf")), finalUrl: "", contentType: "application/pdf" }));
    mocks.gemini.mockResolvedValue({ status: "error", extractedContent: "", error: `No text could be read from "r.pdf". ${UPLOAD_ADVICE}`, processedAt: "", fileCount: 0 });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error", extraction_error: `No text could be read from "r.pdf". ${LINKED_PDF_ADVICE}` });

    mocks.gemini.mockResolvedValue({ status: "error", extractedContent: "", error: "Gemini API not configured", processedAt: "", fileCount: 0 });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error", extraction_error: `Gemini API not configured. ${LINKED_PDF_ADVICE}` });
  });

  it("deletes the copy a re-read of a linked PDF replaces", async () => {
    const s = await createSource(T, "ann", { kind: "url", url: "https://example.org/r.pdf" });
    const OLD = "https://abc.public.blob.vercel-storage.com/sources/h/id/r-old.pdf";
    const NEW = "https://abc.public.blob.vercel-storage.com/sources/h/id/r-new.pdf";
    await setSourceFile(T, s.id, { blob_url: OLD, blob_pathname: "sources/h/id/r-old.pdf", bytes: 8, mime: "application/pdf", status: "ready" });
    mocks.put.mockResolvedValue({ url: NEW, pathname: "sources/h/id/r-new.pdf" });
    mocks.gemini.mockResolvedValue({ status: "success", extractedContent: "--- Page 1 ---\nPDF text.", processedAt: "", fileCount: 1 });
    mocks.fetchUrl.mockImplementation(async (_url, opts) => ({ title: null, text: await opts.onPdf(Buffer.from("%PDF"), new URL("https://example.org/r.pdf")), finalUrl: "", contentType: "application/pdf" }));
    await ingestSource(T, s.id, "ann");
    expect(mocks.del).toHaveBeenCalledWith(OLD);
    expect(mocks.del).not.toHaveBeenCalledWith(NEW);
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", blob_url: NEW });
  });

  it("deletes a linked PDF it stored for a source removed meanwhile", async () => {
    const s = await createSource(T, "ann", { kind: "url", url: "https://example.org/r.pdf" });
    const NEW = "https://abc.public.blob.vercel-storage.com/sources/h/id/r-new.pdf";
    mocks.put.mockImplementation(async () => {
      await deleteSource(T, s.id);
      return { url: NEW, pathname: "sources/h/id/r-new.pdf" };
    });
    mocks.fetchUrl.mockImplementation(async (_url, opts) => ({ title: null, text: await opts.onPdf(Buffer.from("%PDF"), new URL("https://example.org/r.pdf")), finalUrl: "", contentType: "application/pdf" }));
    await expect(ingestSource(T, s.id, "ann")).resolves.toBeUndefined();
    expect(mocks.del).toHaveBeenCalledWith(NEW);
    expect(mocks.gemini).not.toHaveBeenCalled();
  });

  it("keeps extraction and summary inside the function's time limit", async () => {
    expect(INGEST_BUDGET_MS).toBeLessThanOrEqual(250_000);
    vi.useFakeTimers();
    try {
      // Extraction that never returns gives up at its budget, as an error.
      const slow = await fileSource("application/pdf", "huge.pdf");
      mocks.gemini.mockReturnValue(new Promise(() => {}));
      const reading = ingestSource(T, slow.id, "ann");
      await vi.advanceTimersByTimeAsync(EXTRACTION_BUDGET_MS + 1);
      await reading;
      expect(await getSource(T, slow.id)).toMatchObject({ extraction_status: "error" });

      // A summary that never returns is cut off at what's left of the overall budget.
      const s = await fileSource("application/pdf", "report.pdf");
      mocks.gemini.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, EXTRACTION_BUDGET_MS - 1000));
        return { status: "success", extractedContent: "--- Page 1 ---\nThe plan was approved.", processedAt: "", fileCount: 1 };
      });
      mocks.summarize.mockReturnValue(new Promise(() => {}));
      const started = Date.now();
      const done = ingestSource(T, s.id, "ann");
      await vi.advanceTimersByTimeAsync(INGEST_BUDGET_MS + 1);
      await done;
      expect(Date.now() - started).toBeLessThanOrEqual(INGEST_BUDGET_MS + 1);
      expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", summary: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a link error's own message", async () => {
    const s = await createSource(T, "ann", { kind: "url", url: "https://example.org/x" });
    mocks.fetchUrl.mockRejectedValue(new UrlSourceError("The page returned an error (404)."));
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error", extraction_error: "The page returned an error (404)." });
  });

  it("reads a note's own text", async () => {
    const s = await createSource(T, "ann", { kind: "note", title: "Call notes", extracted_text: "Spoke with the director about timing." });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", title: "Call notes", summary: "A short summary." });
    expect(await listPassages(T, s.id)).toHaveLength(1);
  });

  it("errors on empty text", async () => {
    const s = await createSource(T, "ann", { kind: "note", title: "Empty", extracted_text: "   " });
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "error", extraction_error: "No readable text was found in this note." });
  });

  it("is ready without a summary when summarizing fails or Claude is off", async () => {
    const s = await createSource(T, "ann", { kind: "note", title: "n", extracted_text: "Some text." });
    mocks.summarize.mockRejectedValue(new Error("overloaded"));
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", summary: null });

    mocks.summarize.mockResolvedValue(null);
    await ingestSource(T, s.id, "ann");
    expect(await getSource(T, s.id)).toMatchObject({ extraction_status: "ready", summary: null });
  });

  it("does nothing for another team's source", async () => {
    const s = await createSource(T, "ann", { kind: "note", title: "n", extracted_text: "Some text." });
    await ingestSource("org:b", s.id, "eve");
    expect((await getSource(T, s.id))?.extraction_status).toBe("pending");
  });
});
