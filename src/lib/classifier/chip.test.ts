import { describe, expect, it } from "vitest";
import { chipSuggestion } from "./chip";
import { ClassifierState, type ChipInput, type ClassifyCandidate } from "./contract";

const titles = new Map([
  ["proposal", "Proposal"],
  ["business-plan", "Business Plan"],
  ["general-report", "General Report"],
  ["design-doc-rfc", "Design Doc"],
]);

const c = (key: string, confidence: number, why = `why ${key}`): ClassifyCandidate => ({ key, confidence, why });

const state = (candidates: ClassifyCandidate[], over: { freeform?: boolean; trigger?: "content" | "notes" | "drift" | "manual"; dismissals?: Record<string, number> } = {}) =>
  ClassifierState.parse({
    last: { candidates, freeform: over.freeform ?? false, at: "2026-10-08T00:00:00.000Z", trigger: over.trigger ?? "content" },
    dismissals: over.dismissals ?? {},
  });

const chip = (over: Partial<ChipInput>) => chipSuggestion({ state: state([]), typeKey: null, typeSource: null, titles, ...over });

describe("chipSuggestion", () => {
  it("hides with no result or a freeform one", () => {
    expect(chip({ state: ClassifierState.parse({}) })).toBeNull();
    expect(chip({ state: state([c("proposal", 0.9)], { freeform: true }) })).toBeNull();
  });

  it("shows the top candidate on an untyped document at the threshold", () => {
    expect(chip({ state: state([c("proposal", 0.59)]) })).toBeNull();
    expect(chip({ state: state([c("proposal", 0.6)]) })).toEqual({ key: "proposal", title: "Proposal", confidence: 0.6, why: "why proposal", alternatives: [] });
  });

  it("ignores keys outside the enabled titles", () => {
    const s = chip({ state: state([c("retired-type", 0.95), c("proposal", 0.7), c("old", 0.5)]) });
    expect(s?.key).toBe("proposal");
    expect(s?.alternatives).toEqual([]);
  });

  it("blocks a type dismissed 3 times, and one dismissed locally", () => {
    const st = (n: number) => state([c("proposal", 0.9), c("business-plan", 0.7)], { dismissals: { proposal: n } });
    expect(chip({ state: st(2) })?.key).toBe("proposal");
    expect(chip({ state: st(3) })?.key).toBe("business-plan");
    expect(chip({ state: st(0), locallyDismissed: new Set(["proposal"]) })?.key).toBe("business-plan");
    expect(chip({ state: st(0), locallyDismissed: new Set(["proposal", "business-plan"]) })).toBeNull();
  });

  it("lists alternatives at or above 0.25, excluding the current type and blocked ones", () => {
    const s = chip({
      state: state([c("proposal", 0.8), c("business-plan", 0.25), c("general-report", 0.24)]),
    });
    expect(s?.alternatives.map((a) => [a.key, a.title])).toEqual([["business-plan", "Business Plan"]]);
    const blocked = chip({ state: state([c("proposal", 0.8), c("business-plan", 0.5)], { dismissals: { "business-plan": 3 } }) });
    expect(blocked?.alternatives).toEqual([]);
  });

  it("on a typed document shows only a strong drift away from the current type", () => {
    const typed = { typeKey: "general-report", typeSource: "user" as const };
    const drift = (cands: ClassifyCandidate[], trigger: "content" | "drift" = "drift") => chip({ ...typed, state: state(cands, { trigger }) });
    expect(drift([c("proposal", 0.85), c("general-report", 0.3)])?.key).toBe("proposal");
    expect(drift([c("proposal", 0.85)])?.alternatives).toEqual([]);
    // Not a drift run.
    expect(drift([c("proposal", 0.85)], "content")).toBeNull();
    // Too weak.
    expect(drift([c("proposal", 0.79)])).toBeNull();
    // The current type still scores too well.
    expect(drift([c("proposal", 0.85), c("general-report", 0.31)])).toBeNull();
    // The top is the current type.
    expect(drift([c("general-report", 0.9), c("proposal", 0.85)])).toBeNull();
    // Alternatives never include the current type.
    expect(drift([c("proposal", 0.85), c("business-plan", 0.4), c("general-report", 0.2)])?.alternatives.map((a) => a.key)).toEqual(["business-plan"]);
  });
});
