// "Tell me what doc you'd like": the empty editor's prompt-to-document flow
// (redesign2-spec.md §6). Client-safe (zod, types and pure helpers only): the
// route parses requests with these schemas and the editor's use-tell-me hook
// builds them from the same types.
//
// The flow: POST /api/documents/[id]/start-from-prompt picks a type from the
// prompt (one fast-tier `classify.prompt` call, the caller's "light"
// allowance) and stores nothing. The editor then sets the type, saves the
// prompt to the document notes, lays out the type's outline and drafts each
// draftable section through the existing section generate route (one "draft"
// call each) with tellMeInstruction(prompt), then applies everything as one
// undo step.
//
// CONTRACT (redesign 2): owned by the empty-state track; the header track
// (document-screen wiring) and the tests track import it. Change a shape only
// with every consumer updated in the same change.

import { z } from "zod";
import type { SectionSummary } from "@/catalog/schema";
import { ClassifyCandidate, type ClassifyResult } from "@/lib/classifier/contract";

/** Longest prompt accepted. The section generate route's `instruction` is capped at 2000; tellMeInstruction adds a short lead-in. */
export const TELL_ME_PROMPT_MAX = 1800;
/** Shortest prompt worth a model call (characters, after trimming). */
export const TELL_ME_PROMPT_MIN = 3;
/** The top candidate is taken only at or above this confidence; below it the person chooses the type. */
export const TELL_ME_MIN_CONFIDENCE = 0.35;
/** Sections drafted at once. Each is one Opus call; three keeps the wait short without a burst of 429s. */
export const TELL_ME_CONCURRENCY = 3;

/** POST /api/documents/[id]/start-from-prompt */
export const StartFromPromptRequest = z.strictObject({
  prompt: z.string().trim().min(TELL_ME_PROMPT_MIN, "Say a little more about the document.").max(TELL_ME_PROMPT_MAX),
});
export type StartFromPromptRequest = z.infer<typeof StartFromPromptRequest>;

/**
 * 200 response. `typeKey` is null when no enabled type fits well enough
 * (freeform, or the best candidate under TELL_ME_MIN_CONFIDENCE): the editor
 * then opens the Document Gallery so the person picks one. Errors are
 * { error } with 400 / 404 / 503 / 502, or the 429 RateLimitedBody.
 */
export type StartFromPromptResponse = {
  typeKey: string | null;
  /** A short document title from the prompt, or null. The editor uses it only when the title field is empty. */
  title: string | null;
  /** The top candidate's one-sentence reason, for the progress line ("Drafting a Grant proposal: …"). */
  why: string | null;
  /** Normalized candidates (enabled keys only, best first, at most 3). */
  candidates: ClassifyCandidate[];
};

/** What `classify.prompt` returns. Loose bounds, like ClassifyModelOutput: normalizeResult trims it. */
export const PromptTypeModelOutput = z.object({
  candidates: z.array(z.object({ key: z.string(), confidence: z.number(), why: z.string() })),
  freeform: z.boolean(),
  title: z.string(),
});
export type PromptTypeModelOutput = z.infer<typeof PromptTypeModelOutput>;

/** The type to use from a normalized result: the top candidate when it is confident enough and the result isn't freeform. */
export function pickPromptType(result: ClassifyResult, minConfidence = TELL_ME_MIN_CONFIDENCE): string | null {
  const top = result.candidates[0];
  if (!top || result.freeform || top.confidence < minConfidence) return null;
  return top.key;
}

/** The `instruction` sent with each section's draft request (mode "draft"). */
export function tellMeInstruction(prompt: string): string {
  return `The person described the whole document like this; write this section's part of it: ${prompt.trim()}`;
}

/** The document notes after the prompt is recorded: the prompt as its own paragraph, after any notes already there. */
export function notesWithPrompt(notes: string, prompt: string): string {
  const entry = `What I asked Sasha for: ${prompt.trim()}`;
  return notes.trim() ? `${notes.trimEnd()}\n\n${entry}` : entry;
}

/** The sections a prompt draft fills: every section except fixed (static) ones, which keep their scaffold. */
export function draftableSections<T extends Pick<SectionSummary, "renderer">>(sections: T[]): T[] {
  return sections.filter((s) => s.renderer !== "static");
}

/** Progress of one run, as the helper shows it. */
export type TellMePhase = "idle" | "choosing" | "needs_type" | "drafting" | "done" | "failed";

export type TellMeState = {
  phase: TellMePhase;
  /** The prompt being worked on (kept so "needs_type" can continue with a chosen type). */
  prompt: string;
  /** Sections drafted so far and the number to draft. */
  done: number;
  total: number;
  /** Headings being drafted right now. */
  current: string[];
  /** Plain sentences: each section that failed and why, or the run's failure. */
  errors: string[];
  /** True once the person pressed Stop: running sections finish, no new ones start. */
  cancelled: boolean;
};

export const IDLE_TELL_ME: TellMeState = { phase: "idle", prompt: "", done: 0, total: 0, current: [], errors: [], cancelled: false };
