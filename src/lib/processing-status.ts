// Helpers for making document processing reliably reach a terminal state.
//
// Background: uploads kick off Gemini extraction after the HTTP response is sent.
// On Vercel the function instance can be frozen/killed once it responds, which
// left cases stuck on status "processing" forever with no error. We now run that
// work inside `after()` (keeps the function alive) AND bound it with a timeout so
// a slow/hung job is recorded as an error instead of hanging.

import { put } from "@vercel/blob";
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
    return `${err.message}. The packet may be large or the AI service slow — please retry (delete and re-upload the case).`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Processing failed: ${msg}`;
}

/**
 * Self-heal a case whose completion write was partially clobbered by a
 * concurrent, stale-read metadata write on the eventually-consistent blob: if the
 * extracted text is present but the status was left/reverted to "processing",
 * report it as "completed" so the case leaves the stalled state on its next read.
 *
 * Keyed on `extractedContent` specifically — NOT on a determination existing in
 * Postgres — because the governed pipeline runs BEFORE the completion write. The
 * completion write sets status, extractedContent and subjectInfo together, so a
 * determination can exist while the name has not been written yet. Reporting
 * "completed" off the determination would stop the case list's poll early and
 * leave the card nameless until a manual refresh. Pure; returns the same object
 * when no correction applies.
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

/**
 * Write a terminal "error" status to the group metadata so the case leaves the
 * "processing" state and the UI can show what went wrong. Never throws.
 */
export async function writeProcessingError(groupId: string, metadata: object, message: string): Promise<void> {
  const m = metadata as Record<string, unknown>;
  try {
    await put(
      `upload-groups/${groupId}/metadata.json`,
      JSON.stringify({
        ...m,
        geminiProcessing: {
          ...(typeof m.geminiProcessing === "object" && m.geminiProcessing ? m.geminiProcessing : {}),
          status: "error",
          error: message,
          processedAt: new Date().toISOString(),
        },
      }),
      { access: "public", contentType: "application/json", allowOverwrite: true },
    );
  } catch (e) {
    console.error(`[Processing] Failed to write error status for ${groupId}:`, e);
  }
}
