// Shared plumbing for "upload a file to Gemini, then actually use it".
//
// The Files API returns as soon as the bytes land, with the file in PROCESSING.
// A PDF is not readable until it reaches ACTIVE, and calling generateContent
// against a PROCESSING file fails the whole request with FAILED_PRECONDITION —
// one not-yet-ready file kills every other file in the same call.
//
// The document pipeline already polled for ACTIVE; the assessment score
// extractor slept a flat 5s and hoped. That is the difference between "usually
// works" and "works", and it is why a long score report intermittently came back
// as "the score extraction request failed".

import type { GoogleGenAI } from "@google/genai";

export const READY_TIMEOUT_MS = 60_000;
export const READY_POLL_MS = 1_000;

export type UploadedFile = { uri: string; mimeType: string; name: string };

/** Why a file never became usable — kept so callers can say something specific. */
export type NotReady = { name: string; reason: "failed" | "timeout" };

/**
 * Poll one uploaded file until it reports ACTIVE. Resolves false when the file
 * processing FAILED outright or the deadline passed.
 */
export async function waitForActive(
  ai: Pick<GoogleGenAI, "files">,
  fileName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? READY_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let state = "PROCESSING";
    try {
      const f = await ai.files.get({ name: fileName });
      state = f.state || "PROCESSING";
    } catch {
      // A transient get() failure is not a verdict on the file — keep polling
      // until the deadline rather than discarding a file that is probably fine.
    }
    if (state === "ACTIVE") return true;
    if (state === "FAILED") return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Wait for a batch concurrently, partitioning into usable and not.
 *
 * Partitioning rather than throwing is deliberate: dropping the one file that
 * never came up still lets the other reports be read, which beats failing the
 * user's whole action over a single slow PDF.
 */
export async function waitForActiveFiles(
  ai: Pick<GoogleGenAI, "files">,
  files: UploadedFile[],
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ ready: UploadedFile[]; notReady: NotReady[] }> {
  const outcomes = await Promise.all(
    files.map(async (f) => ({ file: f, ok: await waitForActive(ai, f.name, opts) })),
  );
  return {
    ready: outcomes.filter((o) => o.ok).map((o) => o.file),
    notReady: outcomes.filter((o) => !o.ok).map((o) => ({ name: o.file.name, reason: "timeout" as const })),
  };
}

/** Best-effort cleanup. Files expire after 48h anyway, so failure is ignorable. */
export async function deleteFiles(ai: Pick<GoogleGenAI, "files">, files: UploadedFile[]): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      try {
        await ai.files.delete({ name: f.name });
      } catch {
        /* ignore */
      }
    }),
  );
}

// --- error classification -------------------------------------------------

export type GeminiFailure = {
  /** Safe to retry the identical request after a pause. */
  transient: boolean;
  /** Plain-language cause for the person who clicked the button. */
  message: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Turn a thrown Gemini error into something worth showing a school psychologist.
 *
 * "the score extraction request failed" told the user nothing and told us
 * nothing — rate limiting, an overloaded model, and a file that wasn't ready
 * all produced the same eight words, so there was no way to know whether
 * retrying would help.
 */
export function classifyGeminiError(error: unknown): GeminiFailure {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes("not in an active state") || lower.includes("failed_precondition")) {
    return { transient: true, message: "the score report was still being prepared for reading — try again in a moment" };
  }
  if (lower.includes("429") || lower.includes("resource_exhausted") || lower.includes("rate limit") || lower.includes("quota")) {
    return { transient: true, message: "the model is rate-limited right now — wait a minute and try again" };
  }
  if (lower.includes("503") || lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("500") || lower.includes("internal")) {
    return { transient: true, message: "the model was temporarily unavailable — try again in a moment" };
  }
  if (lower.includes("deadline") || lower.includes("timeout") || lower.includes("etimedout") || lower.includes("aborted")) {
    return { transient: true, message: "reading the score report timed out — try again, or split very large reports" };
  }
  if (lower.includes("api key") || lower.includes("401") || lower.includes("403") || lower.includes("permission_denied")) {
    return { transient: false, message: "the model rejected the request credentials — this needs an admin" };
  }
  if (lower.includes("400") || lower.includes("invalid_argument")) {
    return { transient: false, message: `the model could not read this document (${firstLine(text)})` };
  }
  return { transient: false, message: `the score extraction failed (${firstLine(text)})` };
}

/** Keep error surfaces to one readable line — stack traces help nobody here. */
function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Run `fn`, retrying only failures classified as transient. Fixed small backoff:
 * the caller is a user waiting on a button, not a batch job.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; backoffMs?: number; label?: string; /** Epoch ms after which no retry starts. */ deadline?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 2_000;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const { transient } = classifyGeminiError(error);
      const wait = backoffMs * (i + 1);
      if (!transient || i === attempts - 1) throw error;
      if (opts.deadline !== undefined && Date.now() + wait >= opts.deadline) throw error;
      console.warn(`[gemini] ${opts.label ?? "request"} failed (attempt ${i + 1}/${attempts}), retrying:`, errorText(error));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
