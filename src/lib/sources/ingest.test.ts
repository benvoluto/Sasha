import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gemini: vi.fn(),
  download: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  summarize: vi.fn(),
  fetchUrl: vi.fn(),
}));
vi.mock("@/lib/gemini", () => ({ processDocumentsWithGemini: mocks.gemini }));
vi.mock("@/lib/blob-download", () => ({ downloadBlobContent: mocks.download }));
vi.mock("@vercel/blob", () => ({ put: mocks.put, del: mocks.del, list: vi.fn() }));
vi.mock("./summarize", () => ({ summarizeSource: mocks.summarize }));
vi.mock("./url-extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./url-extract")>()),
  fetchUrlSource: mocks.fetchUrl,
}));

import { resetMemoryStore } from "@/lib/documents/store";
import { EXTRACTION_BUDGET_MS, INGEST_BUDGET_MS, ingestSource } from "./ingest";
import { createSource, deleteSource, getSource, listPassages, resetSourceStore, setSourceFile } from "./store";
import { UrlSourceError } from "./url-extract";

const T = "org:a";
const BLOB = "https://abc.public.blob.vercel-storage.com/sources/x/file.pdf";

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

  it("stores a spreadsheet without reading it yet", async () => {
    const s = await fileSource("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "data.xlsx");
    await ingestSource(T, s.id, "ann");
    expect(mocks.gemini).not.toHaveBeenCalled();
    expect(mocks.summarize).not.toHaveBeenCalled();
    const after = await getSource(T, s.id);
    expect(after?.extraction_status).toBe("partial");
    expect(after?.extraction_error).toMatch(/Spreadsheet/);
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
