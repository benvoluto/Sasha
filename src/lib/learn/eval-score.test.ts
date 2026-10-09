import { describe, expect, it } from "vitest";
import type { EvalCaseResult, EvalConditionResult, EvalReport, EvalScores } from "./contract";
import { bestCondition, combinedScore, coverageScore, headingsMatch, headingSimilarity, headingWords, meanRubric, reportMarkdown, structureScore, summarize } from "./eval-score";

const scores = (structure: number, coverage: number, rubric: number | null = null): EvalScores => ({ structure, coverage, rubric, findings: { blocking: 0, warning: 1, info: 2 }, outcome: "ready" });
const cond = (condition: EvalConditionResult["condition"], s: EvalScores | null, error: string | null = null): EvalConditionResult => ({ condition, typeKey: condition === "none" ? null : "t", scores: s, error, durationMs: 1, tokens: 10 });
const kase = (id: string, conditions: EvalConditionResult[]): EvalCaseResult => ({ caseId: id, title: `Case ${id}`, family: "grant", keyPoints: [], exampleHeadings: [], extraction: { confidence: "low", overlaps: 0, personalDetails: 0 }, conditions, best: bestCondition(conditions) });

describe("headings", () => {
  it("compares words without numbering, punctuation or stopwords", () => {
    expect(headingWords("2. Aims of the Study")).toEqual(["aims", "study"]);
    expect(headingWords("IV) Budget")).toEqual(["budget"]);
    expect(headingSimilarity("Specific Aims", "SPECIFIC AIMS:")).toBe(1);
    expect(headingSimilarity("Methods", "Results")).toBe(0);
    expect(headingsMatch("Budget", "Budget justification")).toBe(true);
    expect(headingsMatch("Research Strategy", "Strategy for research")).toBe(true);
    expect(headingsMatch("Background", "Approach")).toBe(false);
  });
});

describe("structureScore (order-aware F1)", () => {
  const ex = ["Summary", "Background", "Methods", "Budget"];

  it("is 1 for the same headings in the same order", () => {
    expect(structureScore(ex, ["1. Summary", "Background", "Methods", "Budget"]).f1).toBe(1);
  });

  it("counts only headings in the same order", () => {
    // Two in order (Summary, Budget) out of four on each side.
    const r = structureScore(ex, ["Budget", "Summary", "Results", "Budget plan"]);
    expect(r.matched).toBe(2);
    expect(r.f1).toBeCloseTo(0.5);
  });

  it("penalizes extra and missing sections through precision and recall", () => {
    const r = structureScore(ex, ["Summary", "Methods"]);
    expect(r).toMatchObject({ matched: 2, precision: 1, recall: 0.5 });
    expect(r.f1).toBeCloseTo(2 / 3);
    expect(structureScore(ex, []).f1).toBe(0);
    expect(structureScore([], []).f1).toBe(1);
  });
});

describe("coverage, rubric, best and summary", () => {
  it("scores coverage with partial as half", () => {
    expect(coverageScore(["covered", "partial", "missing", "covered"])).toBe(0.625);
    expect(coverageScore([])).toBe(0);
    expect(meanRubric([4, 8])).toBe(6);
    expect(meanRubric([])).toBeNull();
    expect(combinedScore(scores(0.5, 0.5, 6))).toBeCloseTo(1.6);
  });

  it("picks the best condition by structure + coverage + rubric/10, null when all failed", () => {
    expect(bestCondition([cond("extracted", scores(0.9, 0.5, 6)), cond("nearest", scores(0.6, 0.6, 8)), cond("none", null, "boom")])).toBe("extracted");
    expect(bestCondition([cond("extracted", null, "x"), cond("nearest", null, "y")])).toBeNull();
  });

  it("summarizes means per condition and decides the verdict only with two or more comparable cases", () => {
    const cases = [
      kase("a", [cond("extracted", scores(1, 0.8, 7)), cond("nearest", scores(0.5, 0.6, 6)), cond("none", scores(0.2, 0.4))]),
      kase("b", [cond("extracted", scores(0.8, 0.6, 5)), cond("nearest", scores(0.6, 0.4, 7)), cond("none", null, "failed")]),
      kase("c", [cond("extracted", null, "failed"), cond("nearest", scores(0.4, 0.4, 6))]),
    ];
    const s = summarize(cases);
    expect(s.byCondition.extracted).toEqual({ structure: 0.9, coverage: 0.7, rubric: 6, cases: 2 });
    expect(s.byCondition.none).toEqual({ structure: 0.2, coverage: 0.4, rubric: null, cases: 1 });
    expect(s).toMatchObject({ extractedBeatsNearest: 2, total: 3, verdict: "beats-nearest" });
    expect(summarize(cases.slice(0, 1)).verdict).toBe("inconclusive");
    const losing = [kase("a", [cond("extracted", scores(0.1, 0.1)), cond("nearest", scores(1, 1))]), kase("b", [cond("extracted", scores(0.1, 0.1)), cond("nearest", scores(1, 1))])];
    expect(summarize(losing).verdict).toBe("does-not-beat-nearest");
  });

  it("renders a Markdown report with a row per condition and the best marked", () => {
    const cases = [kase("a", [cond("extracted", scores(1, 0.8, 7)), cond("nearest", scores(0.5, 0.6, 6)), cond("none", null, "a | b")])];
    const report: EvalReport = { version: 1, ranAt: "2026-10-08T00:00:00Z", models: { draft: "claude-opus-5-5" }, cases, summary: summarize(cases) };
    const md = reportMarkdown(report);
    expect(md).toContain("**Verdict: inconclusive**");
    expect(md).toContain("| extracted ★ | t | 100% | 80% | 7.0 | 0/1/2 | ready |  |");
    expect(md).toContain("a \\| b");
  });
});
