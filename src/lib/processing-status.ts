// Helpers for making document processing reliably reach a terminal state.
//
// Background: uploads kick off Gemini extraction after the HTTP response is sent.
// On Vercel the function instance can be frozen/killed once it responds, which
// left work stuck "processing" forever with no error. That work runs inside
// `after()` (keeps the function alive) AND is bounded with a timeout so a
// slow/hung job is recorded as an error instead of hanging.
//
// reconcileGeminiStatus reads the organizer's extraction status shape (kept for
// its tests); sources keep their status in Postgres (src/lib/sources/ingest.ts).

import { documentSections, emptyExtractionMessage, hasReadableText } from "./extracted-text";

export class ProcessingTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "ProcessingTimeoutError";
  }
}

/** Reject if `p` doesn't settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProcessingTimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Turn a processing failure into a clear, user-facing message. */
export function friendlyProcessingError(err: unknown): string {
  if (err instanceof ProcessingTimeoutError) {
    return `${err.message}. The file may be large or the AI service slow. Try again with Retry.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Processing failed: ${msg}`;
}

/**
 * Self-heal a legacy upload group whose completion write was partially clobbered
 * by a concurrent, stale-read metadata write on the eventually-consistent blob:
 * if the extracted text is present but the status was left/reverted to
 * "processing", report it as "completed" so it leaves the stalled state on its
 * next read. Pure; returns the same object when no correction applies.
 */
export function reconcileGeminiStatus<
  T extends { geminiProcessing?: { status?: string; extractedContent?: string; error?: string } | null },
>(meta: T): T {
  const gp = meta.geminiProcessing;
  if (!gp) return meta;
  // Cases recorded before empty reads were caught: "completed" with nothing but
  // the document markers. Report them as the failed read they were. (An empty
  // string is a case whose documents were all removed, not a failed read.)
  if ((gp.status === "completed" || gp.status === "partial") && gp.extractedContent?.trim() && !hasReadableText(gp.extractedContent)) {
    const names = documentSections(gp.extractedContent).map((d) => d.name);
    return { ...meta, geminiProcessing: { ...gp, status: "error", error: emptyExtractionMessage(names) } };
  }
  if (gp.status !== "processing") return meta;
  if (!hasReadableText(gp.extractedContent)) return meta;
  return { ...meta, geminiProcessing: { ...gp, status: "completed" } };
}
