// Request and response shapes for the Phase 4 document-type classifier
// (PLAN §6.3, decision 10), plus the pure trigger-logic interfaces. Client-safe
// (zod and types only).
//
// CONTRACT (Phase 4): see phase4-spec.md §3. Owned by the classifier track;
// the document store (type fields, classifier_state) and the notes-and-modal
// track (document-screen wiring) import it. Change a shape only with every
// consumer updated in the same change.

import { z } from "zod";

// --- Tunables (decision 10) --------------------------------------------------

/** Typing must have paused this long before a content-driven run. */
export const CLASSIFY_IDLE_MS = 5_000;
/** Words changed (bag distance, see TriggerInput) since the last run before a content-driven run. */
export const CLASSIFY_MIN_WORDS_CHANGED = 150;
/** At most one run per document in this window (client gate and server gate). */
export const CLASSIFY_MIN_INTERVAL_MS = 120_000;
/** Below this many words of notes + text together there is nothing to classify. */
export const CLASSIFY_MIN_TOTAL_WORDS = 40;
/** "Not now" this many times for one type and that type is never suggested again for the document. */
export const CLASSIFY_MAX_DISMISSALS = 3;
/** The chip shows a candidate only at or above this confidence (untyped document). */
export const CHIP_MIN_CONFIDENCE = 0.6;
/** Alternatives listed under the chip need at least this confidence. */
export const CHIP_ALT_MIN_CONFIDENCE = 0.25;
/**
 * Drift: once the document has a type, the classifier runs again only when the
 * body has changed strongly within the editing session: the bag distance from
 * the session baseline (the body when the editor opened, or when the type was
 * set or last classified in this session, whichever is latest) reaches
 * max(DRIFT_MIN_WORDS, DRIFT_RATIO × the baseline's word count).
 */
export const DRIFT_MIN_WORDS = 400;
export const DRIFT_RATIO = 0.6;
/** And on a typed document the chip shows only when the new top candidate is this confident and the current type scored at most DRIFT_MAX_CURRENT. */
export const DRIFT_CHIP_MIN_CONFIDENCE = 0.8;
export const DRIFT_MAX_CURRENT = 0.3;
/** Characters of notes + text sent to the model (about 3k tokens). */
export const CLASSIFY_INPUT_CHARS = 12_000;

// --- Stored state -------------------------------------------------------------

export const TYPE_SOURCES = ["user", "classifier", "restructure"] as const;
export type TypeSource = (typeof TYPE_SOURCES)[number];

export const ClassifyCandidate = z.object({
  /** A catalog type key the team has enabled. */
  key: z.string().min(1).max(80),
  confidence: z.number().min(0).max(1),
  /** One short sentence: what in the text points to this type. Shown under the chip. */
  why: z.string().max(300),
});
export type ClassifyCandidate = z.infer<typeof ClassifyCandidate>;

/** What the model returns (also the stored last result). At most 3 candidates, best first. */
export const ClassifyResult = z.object({
  candidates: z.array(ClassifyCandidate).max(3),
  /** True when no catalog type fits well (a freeform document): the chip stays hidden. */
  freeform: z.boolean(),
});
export type ClassifyResult = z.infer<typeof ClassifyResult>;

/** document.classifier_state (JSONB). */
export const ClassifierState = z.object({
  /** The last successful result, with when it ran and why it ran. */
  last: ClassifyResult.extend({ at: z.string(), trigger: z.enum(["content", "notes", "drift", "manual"]) }).nullable().default(null),
  /** "Not now" counts by type key. At CLASSIFY_MAX_DISMISSALS the type is never suggested for this document. */
  dismissals: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Word count of notes + text at the last run (informational; the audit and tests read it). */
  words_at_last_run: z.number().int().min(0).default(0),
});
export type ClassifierState = z.infer<typeof ClassifierState>;

/** Tolerant read of the stored JSON: anything invalid becomes the empty state. */
export function parseClassifierState(raw: unknown): ClassifierState {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  const r = ClassifierState.safeParse(value ?? {});
  return r.success ? r.data : ClassifierState.parse({});
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Routes -------------------------------------------------------------------

/** POST /api/documents/[id]/classify */
export const ClassifyRequest = z.strictObject({
  trigger: z.enum(["content", "notes", "drift", "manual"]),
  // No `force` here: the 2-minute gate is the only server-side cost control, so
  // a request body can never bypass it (ClassifyOptions.force is internal-only).
});
export type ClassifyRequest = z.infer<typeof ClassifyRequest>;

/** The classifier view of a document, returned by GET and POST /classify and the dismiss route. */
export type ClassifierView = {
  type_key: string | null;
  type_source: TypeSource | null;
  type_confidence: number | null;
  last_classified_at: string | null;
  state: ClassifierState;
};

/**
 * POST /classify → 200 { ran: true, view } after a model run;
 * 200 { ran: false, reason, view } when skipped (no Claude, too little text,
 * the result would be the same as cached); 429 { error, retryAfterMs, view }
 * inside the 2-minute window; 404 for another team's document.
 */
export type ClassifyResponse =
  | { ran: true; view: ClassifierView }
  | {
      ran: false;
      /** typed: the person chose the type and the trigger wasn't "drift" (or "manual"). */
      reason: "not_configured" | "too_short" | "unchanged" | "typed" | "failed";
      view: ClassifierView;
    };
export type ClassifyRateLimited = { error: string; retryAfterMs: number; view: ClassifierView };

/** GET /api/documents/[id]/classify → { view } */
export type ClassifierViewResponse = { view: ClassifierView };

/** POST /api/documents/[id]/classify/dismiss — "Not now" on the chip's type: counts it and clears `state.last`, so the chip stays hidden until the next run. */
export const ClassifyDismissRequest = z.strictObject({ key: z.string().min(1).max(80) });
export type ClassifyDismissRequest = z.infer<typeof ClassifyDismissRequest>;

// --- Pure trigger logic (src/lib/classifier/trigger.ts implements) ------------

/** A multiset of lower-cased words, for "words changed" (bag distance). */
export type WordBag = Map<string, number>;

export type TriggerInput = {
  now: number;
  /** When the editor body last changed, and when the notes last changed (ms epoch), or null if never this session. */
  lastContentEditAt: number | null;
  lastNotesEditAt: number | null;
  /** Bag distance between the body now and the body at the last run (or the baseline at load). */
  contentWordsChanged: number;
  /** Whether the notes differ from the notes at the last run. */
  notesChanged: boolean;
  /** Words in notes + body now. */
  totalWords: number;
  /** Last run, client or server (ms epoch), or null. */
  lastRunAt: number | null;
  /** A request is in flight. */
  running: boolean;
  typeKey: string | null;
  typeSource: TypeSource | null;
  /** Session drift baseline's word count (see DRIFT_MIN_WORDS). */
  baselineWords: number;
  /** Bag distance between the body now and the session drift baseline. */
  wordsChangedSinceBaseline: number;
};

export type TriggerDecision =
  | { run: true; trigger: "content" | "notes" | "drift" }
  | { run: false; reason: "running" | "rate_limited" | "not_idle" | "too_short" | "no_change" | "typed_no_drift"; retryInMs?: number };

/** What the chip shows: the top candidate (with its type title) and the alternatives. */
export type ChipSuggestion = {
  key: string;
  title: string;
  confidence: number;
  why: string;
  alternatives: Array<{ key: string; title: string; confidence: number; why: string }>;
};

export type ChipInput = {
  state: ClassifierState;
  typeKey: string | null;
  typeSource: TypeSource | null;
  /** Enabled types the team sees (key → title); candidates outside it are ignored. */
  titles: Map<string, string>;
  /** Keys the person chose "Not now" for in this session but whose count isn't back from the server yet. */
  locallyDismissed?: Set<string>;
};
