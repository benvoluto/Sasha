import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { assembleDocument } from "./gemini-parallel";
import { pageRange, splitPdf } from "./pdf-chunks";

async function pdfOf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]).drawText(`page ${i + 1}`);
  return Buffer.from(await doc.save());
}

describe("splitPdf", () => {
  it("splits a long PDF into page ranges", async () => {
    const chunks = await splitPdf(await pdfOf(23), 10);
    expect(chunks.map(pageRange)).toEqual(["pages 1–10", "pages 11–20", "pages 21–23"]);
    const counts = await Promise.all(chunks.map(async (c) => (await PDFDocument.load(c.bytes)).getPageCount()));
    expect(counts).toEqual([10, 10, 3]);
  });

  it("leaves a short PDF whole", async () => {
    const bytes = await pdfOf(4);
    const chunks = await splitPdf(bytes, 10);
    expect(chunks).toEqual([{ first: 1, last: 4, bytes }]);
  });

  it("reads a PDF it cannot parse whole", async () => {
    const bytes = Buffer.from("not a pdf");
    expect(await splitPdf(bytes, 10)).toEqual([{ first: 1, last: null, bytes }]);
  });
});

const text = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => `--- Page ${first + i} ---\nReferral notes for this page, read in full.`).join("\n");

describe("assembleDocument", () => {
  it("joins chunks in page order under one header", () => {
    const doc = assembleDocument("packet.pdf", [
      { first: 11, last: 20, body: text(11, 20), finishReason: "STOP" },
      { first: 1, last: 10, body: text(1, 10), finishReason: "STOP" },
    ]);
    expect(doc.notes).toEqual([]);
    expect(doc.section!.startsWith("=== Document: packet.pdf ===\n--- Page 1 ---")).toBe(true);
    expect(doc.section!.indexOf("--- Page 10 ---")).toBeLessThan(doc.section!.indexOf("--- Page 11 ---"));
  });

  it("keeps what was read and names the pages that were not", () => {
    const doc = assembleDocument("packet.pdf", [
      { first: 1, last: 10, body: text(1, 10), finishReason: "STOP" },
      { first: 11, last: 20, body: "", finishReason: "MAX_TOKENS" },
      { first: 21, last: 25, body: null, error: "the AI service is overloaded" },
    ]);
    expect(doc.section).toContain("[Pages 11–20 could not be read.]");
    expect(doc.notes).toEqual([
      'No text could be read from pages 11–20 of "packet.pdf" (the AI service ran out of room for its reply).',
      'pages 21–25 of "packet.pdf": the AI service is overloaded',
    ]);
  });

  it("flags a chunk cut off at the output cap", () => {
    const doc = assembleDocument("packet.pdf", [{ first: 1, last: 8, body: text(1, 6), finishReason: "MAX_TOKENS" }]);
    expect(doc.notes).toEqual(['"packet.pdf" was too long to read in full and was read only up to page 6; some pages may be missing.']);
  });

  it("fails a document when no chunk was read", () => {
    const doc = assembleDocument("Jordan_S._Referral_Packet.pdf", [
      { first: 1, last: 10, body: "", finishReason: "MAX_TOKENS" },
      { first: 11, last: 20, body: "", finishReason: "STOP" },
    ]);
    expect(doc.section).toBeNull();
    expect(doc.failure).toContain('No text could be read from "Jordan_S._Referral_Packet.pdf" (the AI service ran out of room for its reply)');
  });
});
