import { describe, expect, it } from "vitest";
import type { RubricCheckResult } from "@/lib/rubric/contract";
import {
  applyState,
  changedSections,
  checkedText,
  checkErrorText,
  CHANGED_CONFIRM,
  dismissKey,
  DISMISSED_STORAGE_KEY,
  findQuote,
  focusAfterDismiss,
  groupOf,
  groupResults,
  levelDescriptor,
  levelPips,
  levelText,
  loadDismissed,
  MAX_DISMISSED,
  needsConfirm,
  saveDismissed,
  scopeText,
  summaryText,
  toggleDismissed,
} from "./check-panel-model";

const levels = [4, 3, 2, 1].map((score) => ({ score, descriptor: `Level ${score}` }));
const result = (criterion: string, level: number, over: Partial<RubricCheckResult> = {}): RubricCheckResult => ({
  criterion,
  label: criterion,
  origin: "universal",
  level,
  maxLevel: 4,
  levels,
  rationale: "",
  evidence: [],
  fix: "Do it.",
  fixSectionId: "s1",
  fixSectionHeading: "Summary",
  ...over,
});

describe("grouping", () => {
  it("puts level 2 and below in Needs work, the top level in Strong, the rest in Could improve", () => {
    expect(groupOf({ level: 1, maxLevel: 4 })).toBe("needs_work");
    expect(groupOf({ level: 2, maxLevel: 4 })).toBe("needs_work");
    expect(groupOf({ level: 3, maxLevel: 4 })).toBe("could_improve");
    expect(groupOf({ level: 4, maxLevel: 4 })).toBe("strong");
    // Below half of a longer scale needs work even above 2.
    expect(groupOf({ level: 4, maxLevel: 10 })).toBe("needs_work");
    expect(groupOf({ level: 7, maxLevel: 10 })).toBe("could_improve");
    // The top of a two-level scale is strong.
    expect(groupOf({ level: 2, maxLevel: 2 })).toBe("strong");
  });

  it("lists non-empty groups in order, each sorted by level with ties in rubric order", () => {
    const groups = groupResults([result("a", 3), result("b", 2), result("c", 1), result("d", 2), result("e", 3)]);
    expect(groups.map((g) => [g.label, g.results.map((r) => r.criterion)])).toEqual([
      ["Needs work", ["c", "b", "d"]],
      ["Could improve", ["a", "e"]],
    ]);
  });

  it("summarizes and writes the level scale in words", () => {
    expect(summaryText([result("a", 1), result("b", 3), result("c", 4)])).toBe("1 criterion at level 1–2 · 2 of 3 need attention");
    expect(summaryText([])).toBe("No criteria were scored.");
    const r = result("a", 2);
    expect(levelText(r)).toBe("2 of 4");
    expect(levelDescriptor(r)).toBe("Level 2");
    expect(levelPips(r)).toEqual([true, true, false, false]);
    expect(scopeText("document", null)).toBe("Whole document");
    expect(scopeText("section", "Budget")).toBe("“Budget” section");
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(checkedText("2026-10-08T11:59:30Z", now)).toBe("Checked just now");
    expect(checkedText("2026-10-08T11:55:00Z", now)).toBe("Checked 5 min ago");
    expect(checkedText("2026-10-08T09:00:00Z", now)).toBe("Checked 3 h ago");
    expect(checkedText("nope", now)).toBe("");
  });
});

describe("stale and apply", () => {
  it("finds sections whose text changed or that were deleted since the check", () => {
    const now: Record<string, string | null> = { s1: "aaaa", s2: "changed", s3: null };
    expect(changedSections({ s1: "aaaa", s2: "bbbb", s3: "cccc" }, (id) => now[id] ?? null)).toEqual(["s2", "s3"]);
    expect(changedSections({ s1: "aaaa" }, (id) => now[id] ?? null)).toEqual([]);
  });

  it("enables Apply only with a fix, a fix section that exists and isn't being written", () => {
    expect(applyState(result("a", 2), { sectionExists: true, busy: false })).toEqual({ enabled: true, reason: null });
    expect(applyState(result("a", 2, { fix: " " }), { sectionExists: true, busy: false }).enabled).toBe(false);
    expect(applyState(result("a", 2, { fixSectionId: null }), { sectionExists: true, busy: false }).enabled).toBe(false);
    expect(applyState(result("a", 2), { sectionExists: false, busy: false })).toEqual({ enabled: false, reason: "That section no longer exists." });
    expect(applyState(result("a", 2), { sectionExists: true, busy: true }).enabled).toBe(false);
  });

  it("asks first when the section's fingerprint differs from the check's", () => {
    expect(needsConfirm("aaaa", "aaaa")).toBe(false);
    expect(needsConfirm("aaaa", "bbbb")).toBe(true);
    expect(needsConfirm(undefined, "aaaa")).toBe(true);
    expect(CHANGED_CONFIRM).toBe("This section changed since the check. Apply the fix to the current text?");
  });

  it("writes error messages, including when to retry", () => {
    expect(checkErrorText(429, { error: "Checked moments ago. Try again in 12s.", retryAfterSeconds: 12 })).toBe("Checked moments ago. Try again in 12s.");
    expect(checkErrorText(429, { retryAfterSeconds: 7.2 })).toBe("Checked moments ago. Try again in 8s.");
    expect(checkErrorText(413, null)).toMatch(/one section at a time/);
    expect(checkErrorText(503, { error: "Claude is not configured." })).toMatch(/isn't set up/);
    expect(checkErrorText(502, {})).toBe("The check failed. Try again.");
  });
});

describe("dismissed fixes", () => {
  const memoryStore = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it("round-trips through storage, newest last, capped", () => {
    const store = memoryStore();
    const key = dismissKey("f".repeat(64), "clarity");
    expect(key).toBe(`${"f".repeat(16)}:clarity`);
    let keys = toggleDismissed([], key, true);
    keys = toggleDismissed(keys, "x:concision", true);
    saveDismissed(store, keys);
    expect(loadDismissed(store)).toEqual([key, "x:concision"]);
    expect(toggleDismissed(keys, key, false)).toEqual(["x:concision"]);
    saveDismissed(store, Array.from({ length: MAX_DISMISSED + 5 }, (_, i) => `k${i}`));
    const loaded = loadDismissed(store);
    expect(loaded).toHaveLength(MAX_DISMISSED);
    expect(loaded.at(-1)).toBe(`k${MAX_DISMISSED + 4}`);
  });

  it("works with storage absent, blocked or holding junk", () => {
    expect(loadDismissed(undefined)).toEqual([]);
    expect(loadDismissed(null)).toEqual([]);
    expect(() => saveDismissed(undefined, ["a"])).not.toThrow();
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadDismissed(blocked)).toEqual([]);
    expect(() => saveDismissed(blocked, ["a"])).not.toThrow();
    const junk = memoryStore();
    junk.setItem(DISMISSED_STORAGE_KEY, "{not json");
    expect(loadDismissed(junk)).toEqual([]);
    junk.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(loadDismissed(junk)).toEqual([]);
  });
});

describe("findQuote", () => {
  // "Bank works " (pos 10) + bold "£38,400" (pos 21) in one paragraph; "Signage £1,600." in the next (pos 32).
  const runs = [
    { text: "Bank works ", pos: 10 },
    { text: "£38,400", pos: 21 },
    { text: "Signage  £1,600.", pos: 32 },
  ];

  it("finds a quote across marks, ignoring case, spacing and curly quotes", () => {
    expect(findQuote(runs, "bank works £38,400")).toEqual({ from: 10, to: 28 });
    expect(findQuote(runs, "Signage £1,600")).toEqual({ from: 32, to: 47 });
    expect(findQuote([{ text: "It’s “fine”.", pos: 1 }], "it's \"fine\"")).toEqual({ from: 1, to: 12 });
    expect(findQuote(runs, "works £38,400…")).toEqual({ from: 15, to: 28 });
  });

  it("returns null for a missing or too-short quote", () => {
    expect(findQuote(runs, "not there")).toBeNull();
    expect(findQuote(runs, "ba")).toBeNull();
  });
});

describe("focusAfterDismiss", () => {
  it("moves to the next criterion in display order, else the previous, else none", () => {
    // Display order: level 1 before level 3, whatever the input order.
    const visible = [result("b", 3), result("a", 1), result("c", 3)];
    expect(focusAfterDismiss(visible, "a")).toBe("b");
    expect(focusAfterDismiss(visible, "c")).toBe("b");
    expect(focusAfterDismiss([result("only", 2)], "only")).toBeNull();
    expect(focusAfterDismiss(visible, "gone")).toBeNull();
  });
});
