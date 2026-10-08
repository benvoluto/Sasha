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
// directly; an .xlsx is read in process and its sheets rendered as text. Links
// are fetched (url-extract.ts); a link to a PDF is stored in Blob like an
// upload and read with Gemini. Notes already hold their text.
//
// Tables (phase5-spec.md §3.1) come from the same pass: a CSV gives one, an
// .xlsx one per sheet, and an uploaded PDF or image gets a Gemini table pass
// that runs alongside the summary. A table pass that fails or is skipped only
// adds a warning (the source ends partial); the source's earlier tables stay.
// Tables are stored before the terminal status, so a source that shows ready
// already has them.

import { put } from "@vercel/blob";
import { downloadBlobContent } from "@/lib/blob-download";
import type { TableExtractionOutcome } from "@/lib/data/contract";
import { decodeCsv } from "@/lib/data/csv";
import { CSV_MIME, extractGeminiTables, extractSpreadsheetTables, GEMINI_TABLE_MIMES, XLSX_MIME } from "@/lib/data/extract";
import { renderTablesText } from "@/lib/data/render";
import { replaceSourceTables } from "@/lib/data/store";
import { LINKED_PDF_ADVICE, readableText, UPLOAD_ADVICE } from "@/lib/extracted-text";
import { processDocumentsWithGemini } from "@/lib/gemini";
import { friendlyProcessingError, withTimeout } from "@/lib/processing-status";
import { TEXT_MIME_TYPES } from "@/lib/upload-strategy";
import { sourceBlobPath } from "./blob-paths";
import { deleteBlobQuietly } from "./blobs";
import { MAX_PASSAGE_TEXT_CHARS, pagedPassages } from "./pages";
import { claimSourceStatus, getSource, replacePassages, setExtraction, setSourceFile, setSourceStatus, setSummary, setTitleIfMissing, TERMINAL_STATUSES, type SourceRecord } from "./store";
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
/** Below this much time left, skip the Gemini table pass rather than start it. */
export const MIN_TABLES_MS = 20_000;

export const TABLES_SKIPPED = "Tables weren't read (not enough time). Read it again to try.";
export const TABLES_NOT_SAVED = "Tables in this file couldn't be saved. Read it again to try.";
const TABLES_FAILED = "Tables in this file couldn't be read. Read it again to try.";

type Extracted = {
  text: string;
  status: "ready" | "partial";
  warning: string | null;
  title?: string | null;
  /** The table pass already run during extraction (CSV, XLSX). */
  tables?: TableExtractionOutcome;
};

class IngestError extends Error {}

/** A linked PDF's failed read, with advice that fits a link: it can't be "uploaded again". */
function linkedPdfError(error: unknown): unknown {
  // Timeouts and crashes keep their own message (and the Retry advice that comes with it).
  if (!(error instanceof IngestError)) return error;
  const m = error.message;
  return new IngestError(m.includes(UPLOAD_ADVICE) ? m.replace(UPLOAD_ADVICE, LINKED_PDF_ADVICE) : `${m.replace(/[.\s]*$/, "")}. ${LINKED_PDF_ADVICE}`);
}

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
        try {
          return (await readGemini({ url: blob.url, name, type: "application/pdf" }, deadline)).text;
        } catch (error) {
          throw linkedPdfError(error);
        }
      },
    });
    return { text: page.text, status: "ready", warning: null, title: page.title };
  }
  if (!source.blob_url) throw new IngestError("The file never finished uploading. Remove it and upload it again.");
  const mime = source.mime ?? "application/octet-stream";
  const name = source.filename ?? "file";
  if (mime === XLSX_MIME) {
    // The sheets are the text: rendered as tab-separated tables for passages and the summary.
    const bytes = await downloadBlobContent(source.blob_url);
    const outcome = await extractSpreadsheetTables(bytes, { name, mime });
    if (!outcome.ok) throw new IngestError(outcome.reason);
    if (!outcome.tables.length) throw new IngestError("No tables were found in this spreadsheet. Check that its sheets have a header and rows, then upload it again.");
    const rendered = renderTablesText(outcome.tables);
    const warnings = [rendered.warning, ...outcome.warnings].filter((w): w is string => !!w);
    return {
      text: rendered.text,
      status: warnings.length ? "partial" : "ready",
      warning: warnings.join(" ") || null,
      tables: { ok: true, tables: outcome.tables, warnings: [] },
    };
  }
  if (TEXT_MIME_TYPES.includes(mime)) {
    const bytes = await downloadBlobContent(source.blob_url);
    // Decoded as the table pass decodes it (BOMs, UTF-16, windows-1252), so a
    // CSV's passages and its table agree and no NUL reaches Postgres.
    const text = decodeCsv(bytes);
    // A CSV is also one table; read from the same bytes.
    const tables = mime === CSV_MIME ? await extractSpreadsheetTables(bytes, { name, mime }) : undefined;
    // Keep a very long text file to what passages can cover, and say so.
    if (text.length > MAX_PASSAGE_TEXT_CHARS) {
      return { text: text.slice(0, MAX_PASSAGE_TEXT_CHARS), status: "partial", warning: "This file is very long; only the first part was read.", tables };
    }
    return { text, status: "ready", warning: null, tables };
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
    // Another read of this source still running keeps it: two would each write a set of tables.
    if (!(await claimSourceStatus(teamId, sourceId, "extracting", ["pending", ...TERMINAL_STATUSES]))) {
      console.warn(`[Ingest] source ${sourceId} is already being read; skipping`);
      return;
    }

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

    const tableWarnings: string[] = [];
    const storeTables = async (outcome: TableExtractionOutcome) => {
      // A failed pass keeps the earlier tables; only a finished one replaces them,
      // and the tables on pages it couldn't read stay.
      if (!outcome.ok) {
        tableWarnings.push(outcome.reason);
        return;
      }
      tableWarnings.push(...outcome.warnings);
      try {
        await replaceSourceTables(teamId, sourceId, agent, outcome.tables, { keepPages: outcome.unread });
      } catch (error) {
        console.error(`[Ingest] storing tables failed for source ${sourceId}:`, error);
        tableWarnings.push(TABLES_NOT_SAVED);
      }
    };
    if (extracted.tables) await storeTables(extracted.tables);

    const summarize = async () => {
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
    };

    // An uploaded PDF or image: Gemini looks for tables while the summary is written.
    const readsTables = source.kind === "file" && !!source.blob_url && GEMINI_TABLE_MIMES.includes(source.mime ?? "");
    const left = started + INGEST_BUDGET_MS - Date.now();
    if (readsTables && left < MIN_TABLES_MS) tableWarnings.push(TABLES_SKIPPED);
    const tablePass =
      readsTables && left >= MIN_TABLES_MS
        ? withTimeout(
            (async () => {
              const bytes = await downloadBlobContent(source.blob_url!);
              return extractGeminiTables(bytes, { name: source.filename ?? "file", mime: source.mime! }, { deadline: started + INGEST_BUDGET_MS });
            })(),
            left,
            "Reading tables",
          )
        : null;
    const [, tables] = await Promise.allSettled([summarize(), tablePass]);
    if (tables.status === "rejected") {
      console.error(`[Ingest] table pass failed for source ${sourceId}:`, tables.reason);
      tableWarnings.push(TABLES_FAILED);
    } else if (tables.value) {
      await storeTables(tables.value);
    }

    const warning = [extracted.warning, ...tableWarnings].filter(Boolean).join(" ") || null;
    await setSourceStatus(teamId, sourceId, tableWarnings.length ? "partial" : extracted.status, warning);
  } catch (error) {
    console.error(`[Ingest] failed for source ${sourceId}:`, error);
    try {
      await setSourceStatus(teamId, sourceId, "error", friendly(error));
    } catch (e) {
      console.error(`[Ingest] could not record the failure for source ${sourceId}:`, e);
    }
  }
}
