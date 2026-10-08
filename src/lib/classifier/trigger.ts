// When the client asks the classifier to run (PLAN §6.3, decision 10;
// phase4-spec.md §3.3). Pure and client-safe: use-classifier.ts feeds it the
// editing session's timings and word counts, and the server's route repeats
// the 2-minute gate on its own.

import {
  CLASSIFY_IDLE_MS,
  CLASSIFY_MIN_INTERVAL_MS,
  CLASSIFY_MIN_TOTAL_WORDS,
  CLASSIFY_MIN_WORDS_CHANGED,
  DRIFT_MIN_WORDS,
  DRIFT_RATIO,
  type ClassifierView,
  type ClassifyResponse,
  type TriggerDecision,
  type TriggerInput,
  type WordBag,
} from "./contract";

const WORD_RE = /\p{L}[\p{L}\p{N}'-]*/gu;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

/** The lower-cased words of `text`, counted. */
export function wordBag(text: string): WordBag {
  const bag: WordBag = new Map();
  for (const w of words(text)) bag.set(w, (bag.get(w) ?? 0) + 1);
  return bag;
}

/** Words added plus words removed between two bags (a changed word counts twice: one out, one in). */
export function bagDistance(a: WordBag, b: WordBag): number {
  let d = 0;
  for (const [w, n] of a) d += Math.abs(n - (b.get(w) ?? 0));
  for (const [w, n] of b) if (!a.has(w)) d += n;
  return d;
}

/** Words in `text`, counted the way the bags count them. */
export function wordCount(text: string): number {
  return words(text).length;
}

/** Milliseconds until `editedAt` has been idle for CLASSIFY_IDLE_MS (0 when it already has, or never changed). */
function untilIdle(now: number, editedAt: number | null): number {
  return editedAt === null ? 0 : Math.max(0, editedAt + CLASSIFY_IDLE_MS - now);
}

/** Whether to run the classifier now, and if not, why (and when to look again). */
export function shouldClassify(i: TriggerInput): TriggerDecision {
  if (i.running) return { run: false, reason: "running" };
  if (i.lastRunAt !== null && i.now - i.lastRunAt < CLASSIFY_MIN_INTERVAL_MS) {
    return { run: false, reason: "rate_limited", retryInMs: i.lastRunAt + CLASSIFY_MIN_INTERVAL_MS - i.now };
  }
  if (i.totalWords < CLASSIFY_MIN_TOTAL_WORDS) return { run: false, reason: "too_short" };

  const contentWait = untilIdle(i.now, i.lastContentEditAt);
  if (i.typeKey !== null) {
    const needed = Math.max(DRIFT_MIN_WORDS, DRIFT_RATIO * i.baselineWords);
    if (i.wordsChangedSinceBaseline < needed) return { run: false, reason: "typed_no_drift" };
    if (contentWait === 0) return { run: true, trigger: "drift" };
    // Enough drift but still typing: look again once the body is idle.
    return { run: false, reason: "typed_no_drift", retryInMs: contentWait };
  }

  const contentDue = i.contentWordsChanged >= CLASSIFY_MIN_WORDS_CHANGED;
  if (contentDue && contentWait === 0) return { run: true, trigger: "content" };
  const notesWait = untilIdle(i.now, i.lastNotesEditAt);
  if (i.notesChanged && notesWait === 0) return { run: true, trigger: "notes" };
  const waits = [contentDue ? contentWait : null, i.notesChanged ? notesWait : null].filter((w): w is number => w !== null);
  if (waits.length) return { run: false, reason: "not_idle", retryInMs: Math.min(...waits) };
  return { run: false, reason: "no_change" };
}

/**
 * Whether a run's answer moves the session baselines up to the text it ran on.
 * Only when the server actually looked at this text: a run, an unchanged input
 * or a typed document. A failed (or unconfigured, or too-short) attempt keeps
 * them, so the same change triggers a retry once the 2-minute gate reopens.
 */
export function resetsBaselines(out: ClassifyResponse): boolean {
  return out.ran || out.reason === "unchanged" || out.reason === "typed";
}

/**
 * Whether a session starts with empty baselines (everything counts as new):
 * no successful run yet. A document whose only attempts failed has
 * last_classified_at but no result and words_at_last_run 0, and stays
 * eligible. A document whose result was cleared by "Not now" also has no
 * result, but keeps words_at_last_run (a run needs CLASSIFY_MIN_TOTAL_WORDS),
 * so it starts from the current body and notes: the text the person just
 * turned down is not new, and reloading must not re-run the model on it.
 */
export function startsFresh(view: ClassifierView): boolean {
  return view.state.last === null && view.state.words_at_last_run === 0;
}
