// Reading a source after it is added: extract its text, split it into
// passages, and summarize it. Runs in the background (inside `after()`), so it
// never throws; every failure ends as extraction_status "error" with a message
// the person can act on.
//
//   pending → extracting → summarizing → ready
//                                      ↘ partial (some text, some problems)
//             ↘ error
//
// Files go to Gemini (PDF, Word, images); plain text, Markdown and CSV are read
// directly; spreadsheets are stored and read in a later phase. Links are
// fetched (url-extract.ts); a link to a PDF is stored in Blob like an upload
// and read with Gemini. Notes already hold their text.

import { put } from "@vercel/blob";
import { downloadBlobContent } from "@/lib/blob-download";
import { readableText } from "@/lib/extracted-text";
import { processDocumentsWithGemini } from "@/lib/gemini";
import { friendlyProcessingError, withTimeout } from "@/lib/processing-status";
import { DEFERRED_MIME_TYPES, TEXT_MIME_TYPES } from "@/lib/upload-strategy";
import { sourceBlobPath } from "./blob-paths";
import { deleteBlobQuietly } from "./blobs";
import { MAX_PASSAGE_TEXT_CHARS, pagedPassages } from "./pages";
import { getSource, replacePassages, setExtraction, setSourceFile, setSourceStatus, setSummary, setTitleIfMissing, type SourceRecord } from "./store";
import { summarizeSource } from "./summarize";
import { fetchUrlSource, UrlSourceError } from "./url-extract";
import { blobAccess } from "@/lib/blob-access";

// Ingest runs in after() on routes with maxDuration 300, sharing that budget
// with the request. If the platform stops the function, no catch runs and the
// row is left busy, so every step has to finish well inside it. Both limits are
// measured from the start of ingest: extraction (a link's fetch and storing its
// PDF included) gets the first 200s, the summary whatever is left of 240s.
// Everything else (the request, database writes) fits in the remaining minute.
export const EXTRACTION_BUDGET_MS = 200_000;
export const INGEST_BUDGET_MS = 240_000;
/** Below this much time left, skip the summary rather than start it. */
const MIN_SUMMARY_MS = 5_000;

type Extracted = { text: string; status: "ready" | "partial"; warning: string | null; title?: string | null };

class IngestError extends Error {}

async function readGemini(file: { url: string; name: string; type: string }, deadline: number): Promise<Extracted> {
  const result = await withTimeout(processDocumentsWithGemini([file]), Math.max(1, deadline - Date.now()), "Reading the file");
  if (result.status === "error") throw new IngestError(result.error || "The file couldn't be read.");
  return { text: result.extractedContent, status: result.status === "partial" ? "partial" : "ready", warning: result.status === "partial" ? (result.error ?? null) : null };
}

async function extract(teamId: string, source: SourceRecord, deadline: number): Promise<Extracted> {
  if (source.kind === "note") {
    return { text: source.extracted_text ?? "", status: "ready", warning: null };
  }
  if (source.kind === "url") {
    if (!source.url) throw new IngestError("This link source has no address.");
    const page = await fetchUrlSource(source.url, {
      onPdf: async (bytes, finalUrl) => {
        const name = decodeURIComponent(finalUrl.pathname.split("/").filter(Boolean).pop() || "document.pdf");
        const blob = await put(sourceBlobPath(teamId, source.id, name), bytes, { access: blobAccess(), addRandomSuffix: true, contentType: "application/pdf" });
        const stored = await setSourceFile(teamId, source.id, { blob_url: blob.url, blob_pathname: blob.pathname, bytes: bytes.length, mime: "application/pdf", filename: name });
        if (!stored) {
          // Deleted while the link was being fetched: don't leave a public copy behind.
          await deleteBlobQuietly(blob.url, `the PDF of deleted source ${source.id}`);
          throw new IngestError("This source was removed.");
        }
        // A re-read stores a fresh copy; the one it replaces is no longer referenced.
        if (source.blob_url && source.blob_url !== blob.url) await deleteBlobQuietly(source.blob_url, `the previous PDF of source ${source.id}`);
        const read = await readGemini({ url: blob.url, name, type: "application/pdf" }, deadline);
        return read.text;
      },
    });
    return { text: page.text, status: "ready", warning: null, title: page.title };
  }
  if (!source.blob_url) throw new IngestError("The file never finished uploading. Remove it and upload it again.");
  const mime = source.mime ?? "application/octet-stream";
  const name = source.filename ?? "file";
  if (DEFERRED_MIME_TYPES.includes(mime)) {
    return { text: "", status: "partial", warning: "Spreadsheet stored. Reading spreadsheet contents isn't available yet." };
  }
  if (TEXT_MIME_TYPES.includes(mime)) {
    const bytes = await downloadBlobContent(source.blob_url);
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    // Keep a very long text file to what passages can cover, and say so.
    if (text.length > MAX_PASSAGE_TEXT_CHARS) {
      return { text: text.slice(0, MAX_PASSAGE_TEXT_CHARS), status: "partial", warning: "This file is very long; only the first part was read." };
    }
    return { text, status: "ready", warning: null };
  }
  return readGemini({ url: source.blob_url, name, type: mime }, deadline);
}

function friendly(error: unknown): string {
  if (error instanceof UrlSourceError || error instanceof IngestError) return error.message;
  return friendlyProcessingError(error);
}

/** Extract, split and summarize one source. Never throws. */
export async function ingestSource(teamId: string, sourceId: string, agent: string): Promise<void> {
  const started = Date.now();
  try {
    const source = await getSource(teamId, sourceId);
    if (!source || source.extraction_status === "uploading") return;
    await setSourceStatus(teamId, sourceId, "extracting");

    let extracted: Extracted;
    try {
      const deadline = started + EXTRACTION_BUDGET_MS;
      extracted = await withTimeout(extract(teamId, source, deadline), Math.max(1, deadline - Date.now()), "Reading the source");
    } catch (error) {
      console.error(`[Ingest] extraction failed for source ${sourceId}:`, error);
      await setExtraction(teamId, sourceId, { status: "error", text: null, error: friendly(error) });
      await replacePassages(teamId, sourceId, []);
      return;
    }

    // A spreadsheet is stored without text for now; that's expected, not a failure.
    if (!extracted.text.trim() && extracted.status === "partial") {
      await setExtraction(teamId, sourceId, { status: "partial", text: null, error: extracted.warning });
      await replacePassages(teamId, sourceId, []);
      return;
    }
    // Gemini's own check already refused near-empty reads; a short note or page is fine.
    if (!readableText(extracted.text)) {
      const what = source.kind === "url" ? "this page" : source.kind === "note" ? "this note" : "this file";
      await setExtraction(teamId, sourceId, { status: "error", text: extracted.text || null, error: `No readable text was found in ${what}.` });
      await replacePassages(teamId, sourceId, []);
      return;
    }

    await setExtraction(teamId, sourceId, { status: "summarizing", text: extracted.text, error: extracted.warning, title: extracted.title });
    // Passages before the summary, so citations work even if summarizing fails.
    await replacePassages(teamId, sourceId, pagedPassages(sourceId, extracted.text));

    try {
      const left = started + INGEST_BUDGET_MS - Date.now();
      if (left < MIN_SUMMARY_MS) throw new Error(`no time left to summarize (${left}ms)`);
      const current = await getSource(teamId, sourceId);
      const summary = await withTimeout(summarizeSource({ title: current?.title ?? source.filename ?? null, text: extracted.text, agent }), left, "Summarizing");
      if (summary) {
        await setSummary(teamId, sourceId, summary.summary);
        if (summary.title) await setTitleIfMissing(teamId, sourceId, summary.title);
      }
    } catch (error) {
      // A missing summary doesn't make the source unusable.
      console.error(`[Ingest] summary failed for source ${sourceId}:`, error);
    }
    await setSourceStatus(teamId, sourceId, extracted.status, extracted.warning);
  } catch (error) {
    console.error(`[Ingest] failed for source ${sourceId}:`, error);
    try {
      await setSourceStatus(teamId, sourceId, "error", friendly(error));
    } catch (e) {
      console.error(`[Ingest] could not record the failure for source ${sourceId}:`, e);
    }
  }
}
