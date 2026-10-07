// Split a long PDF into page ranges so each is read in its own model call.
// One call per document capped what a document could be: the model's reply
// (and its thinking, which shares the cap) had to hold every page, and a
// 36-page scanned packet already ran out of room or came back empty. Chunks
// keep each reply small and run concurrently, so long packets also finish sooner.

import { PDFDocument } from "pdf-lib";

/** Pages per chunk. About 600 output tokens a scanned page, so 10 pages sits far below the cap. */
export const PAGES_PER_CHUNK = Number(process.env.GEMINI_PAGES_PER_CHUNK) || 10;

/** A range of pages, 1-based and inclusive. `last` is null when the page count is unknown (the PDF could not be parsed). */
export type PdfChunk = { first: number; last: number | null; bytes: Buffer };

export async function splitPdf(bytes: Buffer, pagesPerChunk = PAGES_PER_CHUNK): Promise<PdfChunk[]> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (error) {
    // Let the model try the file whole; it reads some PDFs pdf-lib can't.
    console.warn("[PdfChunks] could not parse the PDF; reading it whole:", error instanceof Error ? error.message : error);
    return [{ first: 1, last: null, bytes }];
  }
  const count = src.getPageCount();
  if (count <= pagesPerChunk) return [{ first: 1, last: count, bytes }];

  const chunks: PdfChunk[] = [];
  for (let start = 0; start < count; start += pagesPerChunk) {
    const indices = Array.from({ length: Math.min(pagesPerChunk, count - start) }, (_, i) => start + i);
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(src, indices)) out.addPage(page);
    chunks.push({ first: start + 1, last: start + indices.length, bytes: Buffer.from(await out.save()) });
  }
  return chunks;
}

export const pageRange = (c: Pick<PdfChunk, "first" | "last">) => (c.last === null ? "all pages" : c.first === c.last ? `page ${c.first}` : `pages ${c.first}–${c.last}`);
