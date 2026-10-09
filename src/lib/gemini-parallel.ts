import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import { downloadBlobContent } from "./blob-download";
import { uploadBytesToGemini } from "./gemini-url-upload";
import { pageRange, splitPdf } from "./pdf-chunks";
import { getMimeTypeFromExtension } from "./resumable-upload";
import { GEMINI_MODEL } from "./gemini-model";
import { auditedGenerate } from "./llm/gemini-audit";
import { classifyGeminiError, waitForActive, withGeminiRetry } from "./gemini-files";
import { describeStop, emptyExtractionMessage, hasReadableText } from "./extracted-text";

export interface GeminiProcessedContent {
  extractedContent: string;
  processedAt: string;
  fileCount: number;
  status: "success" | "error" | "partial";
  error?: string;
}

const UPLOAD_CONCURRENCY = Number(process.env.GEMINI_UPLOAD_CONCURRENCY) || 5;
const GEN_CONCURRENCY = Number(process.env.GEMINI_GEN_CONCURRENCY) || 5;
// Long scanned reports routinely take more than 30s to become readable, and a
// file dropped for not being ready loses that document's content silently.
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
// The model's thinking counts against this cap. At 32k, a 36-page scanned
// packet used ~10k thinking and ran out of room on its last page; a run that
// thought longer got an empty reply. 65,536 is the flash models' maximum.
const MAX_OUTPUT_TOKENS = 65_536;

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the results. This is the whole point of the parallel path:
 * the upload phase and the per-document generation phase both become
 * bounded-concurrency maps instead of serial loops.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveMimeType(file: { name: string; type: string }): string {
  if (file.type === "pdf" || file.type === "application/pdf") return "application/pdf";
  if (
    file.type === "docx" ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return getMimeTypeFromExtension(file.name);
}

const SINGLE_DOC_PROMPT = `Analyze this single document and:
1. Extract all text content.
2. Describe any images, charts, or visual elements found.
3. Organize the content by page, marking each page with "--- Page X ---".
4. Describe any image or visual element with "[Image Description: ...]".

Return ONLY the body content for this one document. Do NOT add a document
title or a "=== Document ===" header — that is added for you. Be thorough and
preserve the original structure where possible.`;

/** The prompt for one chunk: a slice of a longer PDF is told which pages it holds, so page numbers match the whole document. */
function promptFor(c: { first: number; last: number | null; total: number | null }): string {
  if (c.last === null || c.total === null || (c.first === 1 && c.last === c.total)) return SINGLE_DOC_PROMPT;
  return (
    `${SINGLE_DOC_PROMPT}\n\nThis file holds pages ${c.first}–${c.last} of a ${c.total}-page document. ` +
    `Number pages as they are in the full document: the first page here is "--- Page ${c.first} ---".`
  );
}

/** What one chunk's model call produced. */
export type ChunkResult = { first: number; last: number | null; body: string | null; finishReason?: string; error?: string };

/**
 * Join a document's chunks, in page order, into its section of the extracted
 * content, with notes for the user about any pages that were not read. A
 * document with no readable chunk has no section and a `failure` instead.
 */
export function assembleDocument(name: string, chunks: ChunkResult[]): { section: string | null; notes: string[]; failure?: string } {
  const split = chunks.length > 1;
  const where = (c: ChunkResult) => (split ? `${pageRange(c)} of "${name}"` : `"${name}"`);
  const notes: string[] = [];
  const parts: string[] = [];
  for (const c of [...chunks].sort((a, b) => a.first - b.first)) {
    if (c.body && hasReadableText(c.body)) {
      parts.push(c.body);
      if (c.finishReason === "MAX_TOKENS") {
        const lastPage = [...c.body.matchAll(/---\s*Page\s+(\S+)\s*---/gi)].at(-1)?.[1];
        notes.push(`${split ? `${pageRange(c)} of "${name}" were` : `"${name}" was`} too long to read in full${lastPage ? ` and ${split ? "were" : "was"} read only up to page ${lastPage}` : ""}; some pages may be missing.`);
      }
    } else {
      // Keep the gap visible in the text itself, so a reader of the case sees where pages are missing.
      if (split) parts.push(`[${pageRange(c)[0].toUpperCase()}${pageRange(c).slice(1)} could not be read.]`);
      const why = describeStop(c.finishReason);
      notes.push(c.error ? `${where(c)}: ${c.error}` : `No text could be read from ${where(c)}${why ? ` (${why})` : ""}.`);
    }
  }
  const read = chunks.filter((c) => c.body && hasReadableText(c.body));
  if (!read.length) {
    const reason = chunks.find((c) => c.finishReason && c.finishReason !== "STOP")?.finishReason;
    return { section: null, notes: [], failure: chunks.length === 1 && chunks[0].error ? `"${name}": ${chunks[0].error}` : emptyExtractionMessage([name], reason) };
  }
  return { section: `=== Document: ${name} ===\n${parts.join("\n\n")}`, notes };
}

/**
 * Parallel extraction, page range by page range. Faithful drop-in for
 * processDocumentsFromUrls: identical signature, identical return shape, and
 * identical downstream markers ("=== Document: [name] ===" / "--- Page X ---").
 *
 * Differences from the sequential path:
 *   1. Long PDFs are split into chunks of PAGES_PER_CHUNK pages, each read in its
 *      own call, so no reply has to hold a whole packet (a 36-page scan already
 *      overflowed the output cap, or came back empty) and long packets finish
 *      in about the time of one chunk.
 *   2. Uploads and generations run with bounded concurrency across every chunk
 *      of every file.
 *   3. Files are polled to ACTIVE instead of a blanket 5s sleep.
 *   4. The "=== Document ===" header is emitted here, not by the model, so it
 *      can't be mislabelled or dropped; the exclusion splitter depends on it.
 */
export async function processDocumentsFromUrlsParallel(
  files: Array<{ url: string; name: string; type: string }>,
): Promise<GeminiProcessedContent> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return errorResult("Gemini API not configured");
  }

  const ai = new GoogleGenAI({ apiKey });
  const startTime = Date.now();
  console.log(`[GeminiParallel] Starting parallel processing for ${files.length} files`);

  try {
    const failures: string[] = [];

    // Phase 1 — download each file and split long PDFs into page ranges.
    const split = await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
      const mimeType = resolveMimeType(file);
      let bytes: Buffer;
      try {
        bytes = await downloadBlobContent(file.url);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[GeminiParallel] Could not read ${file.name} from storage:`, error);
        failures.push(`Could not read "${file.name}" from storage (${detail}).`);
        return [];
      }
      const pieces = mimeType === "application/pdf" ? await splitPdf(bytes) : [{ first: 1, last: null, bytes }];
      const total = pieces.at(-1)?.last ?? null;
      if (pieces.length > 1) console.log(`[GeminiParallel] ${file.name}: ${total} pages in ${pieces.length} chunks`);
      return pieces.map((p) => ({ ...p, total, mimeType }));
    });
    const chunks = split.flatMap((pieces, fileIndex) => pieces.map((p) => ({ ...p, fileIndex, name: files[fileIndex].name })));

    // Phases 2–3 — per chunk: upload, wait until readable, read. Bounded across
    // all chunks of all files, so a long packet doesn't starve the others.
    const results = await mapWithConcurrency(chunks, GEN_CONCURRENCY, async (chunk): Promise<ChunkResult> => {
      const label = chunks.filter((c) => c.fileIndex === chunk.fileIndex).length > 1 ? `${chunk.name} (${pageRange(chunk)})` : chunk.name;
      const up = await uploadBytesToGemini(chunk.bytes, chunk.name, chunk.mimeType);
      if (!up.ok) {
        console.error(`[GeminiParallel] Upload failed for ${label}: ${up.reason}`);
        return { first: chunk.first, last: chunk.last, body: null, error: up.reason };
      }
      try {
        if (!(await waitForActive(ai, up.file.name, { timeoutMs: READY_TIMEOUT_MS, pollMs: READY_POLL_MS }))) {
          console.error(`[GeminiParallel] File never became readable: ${label}`);
          return { first: chunk.first, last: chunk.last, body: null, error: "could not be prepared for reading" };
        }
        const response = await withGeminiRetry(
          () =>
            auditedGenerate("extract", GEMINI_MODEL, () =>
              ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: createUserContent([promptFor(chunk), createPartFromUri(up.file.uri, up.file.mimeType)]),
                config: { temperature: 0.2, topK: 20, topP: 0.8, maxOutputTokens: MAX_OUTPUT_TOKENS },
              }),
            ),
          { label: `document extraction (${label})` },
        );
        const body = (response.text || "").trim();
        // A block reason explains an empty reply better than the finish reason.
        const finishReason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
        if (!hasReadableText(body)) {
          console.error(`[GeminiParallel] No text for ${label}: finishReason=${finishReason ?? "none"}, ${body.length} chars`);
        } else if (finishReason === "MAX_TOKENS") {
          console.warn(`[GeminiParallel] ${label} hit the output cap (usage ${JSON.stringify(response.usageMetadata ?? {})})`);
        }
        return { first: chunk.first, last: chunk.last, body, finishReason };
      } catch (error) {
        console.error(`[GeminiParallel] Generation failed for ${label}:`, error);
        return { first: chunk.first, last: chunk.last, body: null, error: classifyGeminiError(error).message };
      } finally {
        // Best-effort cleanup; files auto-expire after 48h regardless.
        try {
          await ai.files.delete({ name: up.file.name });
        } catch {
          /* ignore */
        }
      }
    });

    // Phase 4 — put each document back together, in upload order.
    const notes: string[] = [];
    const kept: string[] = [];
    files.forEach((file, fileIndex) => {
      const own = results.filter((_, i) => chunks[i].fileIndex === fileIndex);
      if (!own.length) return; // download failed; already in failures
      const doc = assembleDocument(file.name, own);
      if (doc.section) kept.push(doc.section);
      if (doc.failure) failures.push(doc.failure);
      notes.push(...doc.notes);
    });

    const extractedContent = kept.join("\n\n");
    const succeeded = kept.length;
    console.log(
      `[GeminiParallel] Done in ${Date.now() - startTime}ms — ${succeeded}/${files.length} documents ` +
        `(${chunks.length} chunks), ${extractedContent.length} chars`,
    );

    if (succeeded === 0) {
      // Carry the per-file reasons out. A blanket "failed to process any files"
      // is indistinguishable from a bad key, an unreadable blob, and a rejected
      // PDF — which is exactly the position it left us in.
      return errorResult(failures.length ? failures.join(" ") : "Failed to process any files");
    }
    const complete = succeeded === files.length && !notes.length;
    return {
      extractedContent,
      processedAt: new Date().toISOString(),
      fileCount: succeeded,
      status: complete ? "success" : "partial",
      error: complete
        ? undefined
        : [succeeded < files.length ? `Only ${succeeded} of ${files.length} documents were read.` : "", ...failures, ...notes].filter(Boolean).join(" "),
    };
  } catch (error) {
    console.error("[GeminiParallel] Processing error:", error);
    return errorResult(error instanceof Error ? error.message : "Unknown error");
  }
}

function errorResult(message: string): GeminiProcessedContent {
  return {
    extractedContent: "",
    processedAt: new Date().toISOString(),
    fileCount: 0,
    status: "error",
    error: message,
  };
}
