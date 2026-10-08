import { describe, expect, it } from "vitest";
import { CLASSIFY_IDLE_MS, CLASSIFY_MIN_INTERVAL_MS, type ClassifierView, type ClassifyResponse, type TriggerInput } from "./contract";
import { bagDistance, resetsBaselines, shouldClassify, startsFresh, wordBag, wordCount } from "./trigger";

const NOW = 10_000_000;

const input = (over: Partial<TriggerInput> = {}): TriggerInput => ({
  now: NOW,
  lastContentEditAt: NOW - CLASSIFY_IDLE_MS,
  lastNotesEditAt: null,
  contentWordsChanged: 0,
  notesChanged: false,
  totalWords: 200,
  lastRunAt: null,
  running: false,
  typeKey: null,
  typeSource: null,
  baselineWords: 0,
  wordsChangedSinceBaseline: 0,
  ...over,
});

describe("wordBag / bagDistance / wordCount", () => {
  it("counts lower-cased letter-led words, keeping apostrophes and hyphens", () => {
    const bag = wordBag("The river-bank, the RIVER's bank! 42 x2 ×");
    expect([...bag.entries()]).toEqual([
      ["the", 2],
      ["river-bank", 1],
      ["river's", 1],
      ["bank", 1],
      ["x2", 1],
    ]);
    expect(wordCount("Café au lait, 3 times — naïve.")).toBe(5);
    expect(wordCount("")).toBe(0);
  });

  it("counts words added, removed and changed", () => {
    const a = wordBag("one two two three");
    expect(bagDistance(a, a)).toBe(0);
    expect(bagDistance(a, wordBag("one two three"))).toBe(1);
    expect(bagDistance(a, wordBag("one two two three four"))).toBe(1);
    expect(bagDistance(a, wordBag("one two two tree"))).toBe(2);
    expect(bagDistance(wordBag(""), a)).toBe(4);
    expect(bagDistance(a, wordBag(""))).toBe(4);
  });
});

describe("shouldClassify", () => {
  it("waits while a run is in flight", () => {
    expect(shouldClassify(input({ running: true, contentWordsChanged: 500 }))).toEqual({ run: false, reason: "running" });
  });

  it("gates runs to one per interval (119 s vs 120 s)", () => {
    const at119 = shouldClassify(input({ lastRunAt: NOW - 119_000, contentWordsChanged: 500 }));
    expect(at119).toEqual({ run: false, reason: "rate_limited", retryInMs: 1000 });
    expect(shouldClassify(input({ lastRunAt: NOW - CLASSIFY_MIN_INTERVAL_MS, contentWordsChanged: 500 }))).toEqual({ run: true, trigger: "content" });
  });

  it("skips documents that are too short", () => {
    expect(shouldClassify(input({ totalWords: 39, contentWordsChanged: 500 }))).toEqual({ run: false, reason: "too_short" });
    expect(shouldClassify(input({ totalWords: 40, contentWordsChanged: 500 })).run).toBe(true);
  });

  it("runs on content at exactly 150 words changed once idle 5 s (not 4.9 s)", () => {
    expect(shouldClassify(input({ contentWordsChanged: 149 }))).toEqual({ run: false, reason: "no_change" });
    expect(shouldClassify(input({ contentWordsChanged: 150 }))).toEqual({ run: true, trigger: "content" });
    expect(shouldClassify(input({ contentWordsChanged: 150, lastContentEditAt: NOW - 4_900 }))).toEqual({ run: false, reason: "not_idle", retryInMs: 100 });
  });

  it("treats a never-edited body as idle (a never-classified document is eligible at once)", () => {
    expect(shouldClassify(input({ contentWordsChanged: 300, lastContentEditAt: null }))).toEqual({ run: true, trigger: "content" });
  });

  it("runs on a notes-only change once the notes are idle", () => {
    expect(shouldClassify(input({ notesChanged: true, lastNotesEditAt: NOW - 5_000 }))).toEqual({ run: true, trigger: "notes" });
    expect(shouldClassify(input({ notesChanged: true, lastNotesEditAt: NOW - 2_000 }))).toEqual({ run: false, reason: "not_idle", retryInMs: 3_000 });
    // Content due but still typing; notes idle: the notes run.
    expect(shouldClassify(input({ contentWordsChanged: 200, lastContentEditAt: NOW - 1_000, notesChanged: true, lastNotesEditAt: NOW - 6_000 }))).toEqual({
      run: true,
      trigger: "notes",
    });
    // Both waiting: the sooner one decides when to look again.
    expect(shouldClassify(input({ contentWordsChanged: 200, lastContentEditAt: NOW - 1_000, notesChanged: true, lastNotesEditAt: NOW - 3_000 }))).toEqual({
      run: false,
      reason: "not_idle",
      retryInMs: 2_000,
    });
  });

  it("on a typed document runs only on drift: max(400, 0.6 × baseline) words, body idle", () => {
    const typed = { typeKey: "proposal", typeSource: "user" as const, contentWordsChanged: 1000, notesChanged: true, lastNotesEditAt: NOW - 10_000 };
    // Small baseline: the 400-word floor applies.
    expect(shouldClassify(input({ ...typed, baselineWords: 300, wordsChangedSinceBaseline: 399 }))).toEqual({ run: false, reason: "typed_no_drift" });
    expect(shouldClassify(input({ ...typed, baselineWords: 300, wordsChangedSinceBaseline: 400 }))).toEqual({ run: true, trigger: "drift" });
    // Large baseline: 0.6 × 1000 = 600.
    expect(shouldClassify(input({ ...typed, baselineWords: 1000, wordsChangedSinceBaseline: 599 }))).toEqual({ run: false, reason: "typed_no_drift" });
    expect(shouldClassify(input({ ...typed, baselineWords: 1000, wordsChangedSinceBaseline: 600 }))).toEqual({ run: true, trigger: "drift" });
    // Drift reached but still typing: look again when idle.
    expect(shouldClassify(input({ ...typed, baselineWords: 1000, wordsChangedSinceBaseline: 700, lastContentEditAt: NOW - 4_900 }))).toEqual({
      run: false,
      reason: "typed_no_drift",
      retryInMs: 100,
    });
  });

  it("reports no change when nothing moved", () => {
    expect(shouldClassify(input())).toEqual({ run: false, reason: "no_change" });
  });
});

describe("baselines after a run", () => {
  const view = (over: Partial<ClassifierView> = {}): ClassifierView => ({
    type_key: null,
    type_source: null,
    type_confidence: null,
    last_classified_at: null,
    state: { last: null, dismissals: {}, words_at_last_run: 0 },
    ...over,
  });
  const result = { candidates: [], freeform: true, at: "2026-01-01T00:00:00.000Z", trigger: "content" as const };
  const reply = (reason: Extract<ClassifyResponse, { ran: false }>["reason"]): ClassifyResponse => ({ ran: false, reason, view: view() });

  it("move only when the server judged the text", () => {
    expect(resetsBaselines({ ran: true, view: view() })).toBe(true);
    expect(resetsBaselines(reply("unchanged"))).toBe(true);
    expect(resetsBaselines(reply("typed"))).toBe(true);
    expect(resetsBaselines(reply("failed"))).toBe(false);
    expect(resetsBaselines(reply("not_configured"))).toBe(false);
    expect(resetsBaselines(reply("too_short"))).toBe(false);
  });

  it("a failed run is retried once the gate reopens, without new words", () => {
    // 200 words, the first run fails: the baseline stays empty, so the same change counts again.
    const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const bag = wordBag(text);
    const failed = reply("failed");
    const baseline = resetsBaselines(failed) ? bag : new Map();
    const ranAt = NOW - CLASSIFY_MIN_INTERVAL_MS - 1;
    expect(shouldClassify(input({ contentWordsChanged: bagDistance(bag, baseline), lastRunAt: ranAt }))).toMatchObject({ run: true, trigger: "content" });
  });

  it("a session starts fresh when there's no stored result, even after a failed attempt", () => {
    expect(startsFresh(view())).toBe(true);
    expect(startsFresh(view({ last_classified_at: "2026-01-01T00:00:00.000Z" }))).toBe(true);
    expect(startsFresh(view({ last_classified_at: result.at, state: { last: result, dismissals: {}, words_at_last_run: 200 } }))).toBe(false);
  });

  it("a dismissed result (\"Not now\") does not start fresh, so a reload doesn't re-run on the same text", () => {
    // dismissType clears `last` but keeps words_at_last_run.
    const dismissed = view({ last_classified_at: result.at, state: { last: null, dismissals: { business_plan: 1 }, words_at_last_run: 300 } });
    expect(startsFresh(dismissed)).toBe(false);
    // With the current body as the baseline, an unchanged 300-word draft does not trigger a run.
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const bag = wordBag(text);
    const baseline = startsFresh(dismissed) ? new Map() : bag;
    const ranAt = NOW - CLASSIFY_MIN_INTERVAL_MS - 1;
    expect(shouldClassify(input({ contentWordsChanged: bagDistance(bag, baseline), lastRunAt: ranAt })).run).toBe(false);
  });
});
