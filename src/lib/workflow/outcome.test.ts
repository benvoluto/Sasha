import { describe, expect, it, vi } from "vitest";
import type { CheckpointDecision, ComputeResult, Disagreement, Finding, Outcome, ScoreSummary } from "./contract";
import { OUTCOME_BLOCKED, OUTCOME_BLOCKED_LABEL } from "./contract";
import type { OutcomeReportConfig } from "./node-specs/core";

vi.mock("@/catalog/workflows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/catalog/workflows")>()),
  requirementSet: (key: string) =>
    key === "nih-page-limits"
      ? { key, title: "NIH page limits", effective: "2025-01-25", checked: "2026-10-08", provenance: { url: "https://grants.nih.gov" }, verifyNote: "Verify before relying." }
      : null,
}));

const { conditionHolds, evaluateOutcome, mergeScores, rankFindings, signOutcome, OutcomeValueError } = await import("./outcome");

const f = (id: string, severity: Finding["severity"], over: Partial<Finding> = {}): Finding => ({
  id,
  nodeId: "n",
  kind: "gap",
  severity,
  status: null,
  title: id,
  detail: "",
  location: null,
  evidence: [],
  reviewer: null,
  verified: true,
  fix: "",
  ...over,
});
const score = (item: string, median: number, nodeId = "agree1"): ScoreSummary => ({ item, label: item, median, min: median - 1, max: median + 1, meanTimes10: null, nodeId });
const computed = (ok: boolean | null): ComputeResult => ({ key: "k", label: "k", ok, expected: "", actual: "", detail: "", approximate: false, evidence: [] });
const disagreement = (blocking: boolean): Disagreement => ({ id: "d", nodeId: "agree", item: "x", label: "x", positions: [], blocking });
const decision = (verdict: CheckpointDecision["verdict"], over: Partial<CheckpointDecision> = {}): CheckpointDecision => ({ verdict, note: "", by: "sup@example.com", at: "2026-10-08T12:00:00.000Z", role: "Supervisor", excluded: [], edits: null, ...over });

const config = (over: Partial<OutcomeReportConfig> = {}): OutcomeReportConfig => ({
  label: "Readiness",
  values: [
    { key: "ready", label: "Ready" },
    { key: "ready_after_fixes", label: "Ready after fixes" },
    { key: "not_ready", label: "Not ready" },
  ],
  rules: [
    { value: "not_ready", when: { findings: { severity: ["blocking"], min: 1 } } },
    { value: "ready_after_fixes", when: { anyOf: [{ findings: { severity: ["major"], min: 1 } }, { computeFailed: { min: 1 } }] } },
  ],
  fallback: "ready",
  topFindings: 0,
  topFindingsKinds: [],
  guards: [],
  notAssessed: ["Budget"],
  notes: ["Advisory"],
  requirementSets: [],
  ...over,
});
const state = (over: Partial<Parameters<typeof evaluateOutcome>[2]> = {}) => ({ workflowId: "builtin:type-proposal", steps: {}, checkpoints: {}, labels: {}, ...over });
const facts = (over: Partial<Parameters<typeof conditionHolds>[1]> = {}) => ({ findings: [], disagreements: [], computed: [], scores: [], checkpoints: {}, steps: {}, ...over });

describe("conditionHolds", () => {
  it("counts findings by severity, status and kind", () => {
    const all = [f("a", "major", { kind: "coverage_gap" }), f("b", "minor", { kind: "coverage_gap", status: "weak" }), f("c", "major", { kind: "rubric" })];
    expect(conditionHolds({ findings: { severity: ["major", "minor"], kind: ["coverage_gap"], min: 2 } }, facts({ findings: all }))).toBe(true);
    expect(conditionHolds({ findings: { severity: ["major"], kind: ["coverage_gap"], min: 2 } }, facts({ findings: all }))).toBe(false);
    expect(conditionHolds({ findings: { status: ["weak"], min: 1 } }, facts({ findings: all }))).toBe(true);
    expect(conditionHolds({ findings: { min: 3 } }, facts({ findings: all }))).toBe(true);
  });

  it("counts disagreements, optionally blocking only, and failed computations", () => {
    expect(conditionHolds({ disagreements: { min: 2 } }, facts({ disagreements: [disagreement(false), disagreement(true)] }))).toBe(true);
    expect(conditionHolds({ disagreements: { min: 2, blocking: true } }, facts({ disagreements: [disagreement(false), disagreement(true)] }))).toBe(false);
    expect(conditionHolds({ computeFailed: { min: 1 } }, facts({ computed: [computed(null), computed(true)] }))).toBe(false);
    expect(conditionHolds({ computeFailed: { min: 1 } }, facts({ computed: [computed(false)] }))).toBe(true);
  });

  it("compares a score summary's statistic, and fails when the item has none", () => {
    const s = facts({ scores: [score("overall_impact", 3)] });
    expect(conditionHolds({ score: { item: "overall_impact", stat: "median", op: "<=", value: 3 } }, s)).toBe(true);
    expect(conditionHolds({ score: { item: "overall_impact", stat: "median", op: "<", value: 3 } }, s)).toBe(false);
    expect(conditionHolds({ score: { item: "overall_impact", stat: "max", op: ">=", value: 4 } }, s)).toBe(true);
    expect(conditionHolds({ score: { item: "factor_1", stat: "median", op: "<=", value: 9 } }, s)).toBe(false);
  });

  it("reads checkpoint verdicts and step statuses from the run", () => {
    const s = facts({ checkpoints: { cp: decision("reject") }, steps: { plan: { status: "done" }, write: { status: "skipped" } } });
    expect(conditionHolds({ checkpoint: { verdict: "reject" } }, s)).toBe(true);
    expect(conditionHolds({ checkpoint: { node: "cp2", verdict: "reject" } }, s)).toBe(false);
    expect(conditionHolds({ steps: { node: "write", status: "skipped" } }, s)).toBe(true);
    expect(conditionHolds({ steps: { node: "plan", status: "skipped" } }, s)).toBe(false);
    // Every part must hold; anyOf needs one.
    expect(conditionHolds({ steps: { node: "plan", status: "done" }, checkpoint: { verdict: "approve" } }, s)).toBe(false);
    expect(conditionHolds({ anyOf: [{ steps: { node: "plan", status: "failed" } }, { checkpoint: { verdict: "reject" } }] }, s)).toBe(true);
  });
});

describe("evaluateOutcome", () => {
  it("tries the rules in order and falls back", () => {
    expect(evaluateOutcome(config(), {}, state()).value).toBe("ready");
    expect(evaluateOutcome(config(), { findings: [f("a", "major")] }, state()).value).toBe("ready_after_fixes");
    expect(evaluateOutcome(config(), { results: [computed(false)] }, state()).value).toBe("ready_after_fixes");
    // The first rule that holds wins, even when a later one holds too.
    expect(evaluateOutcome(config(), { findings: [f("a", "major"), f("b", "blocking")] }, state())).toMatchObject({ value: "not_ready", valueLabel: "Not ready" });
  });

  it("puts blocked first, then incomplete, then the value input, then the rules", () => {
    const blocked = { missing: [{ key: "consent", label: "Written consent" }], items: [] };
    const inputs = { blocked: [blocked], findings: [f("a", "blocking")], value: "ready" };
    const failed = { gate: { status: "done" as const }, check: { status: "failed" as const } };
    expect(evaluateOutcome(config(), inputs, state({ steps: failed, labels: { check: "Scope check" } }))).toMatchObject({
      value: OUTCOME_BLOCKED,
      valueLabel: OUTCOME_BLOCKED_LABEL,
      missing: ["Written consent"],
      incomplete: [],
    });
    expect(evaluateOutcome(config(), { ...inputs, blocked: [{ missing: [], items: [] }] }, state({ steps: failed, labels: { check: "Scope check" } }))).toMatchObject({
      value: null,
      valueLabel: "No outcome",
      incomplete: ["Scope check"],
      missing: [],
    });
    expect(evaluateOutcome(config(), { ...inputs, blocked: undefined }, state()).value).toBe("ready");
    expect(() => evaluateOutcome(config(), { value: "great" }, state())).toThrow(OutcomeValueError);
    expect(() => evaluateOutcome(config(), { value: "great" }, state())).toThrow("the decision step returned an unknown value");
  });

  it("assembles the outcome: values with blocked last, rationale, tables, advisory", () => {
    const table = { key: "t", title: "T", columns: [{ key: "a", label: "A" }], rows: [] };
    const o = evaluateOutcome(config(), { rationale: "Because.", summary: ["ignored"], tables: [table, table], results: [computed(true)], agreed: [{ item: "x" }] }, state());
    expect(o.values.map((v) => v.key)).toEqual(["ready", "ready_after_fixes", "not_ready", OUTCOME_BLOCKED]);
    expect(o).toMatchObject({ workflowKey: "type-proposal", label: "Readiness", rationale: "Because.", advisory: true, verdict: null, signedBy: null, notAssessed: ["Budget"], notes: ["Advisory"] });
    expect(o.tables).toHaveLength(2);
    expect(o.computed).toHaveLength(1);
    expect(o.agreed).toHaveLength(1);
    expect(evaluateOutcome(config(), { summary: ["One.", "Two."] }, state()).rationale).toBe("One.\n\nTwo.");
    expect(evaluateOutcome(config(), {}, state({ workflowId: "my-flow-1a2b" })).workflowKey).toBe("my-flow-1a2b");
  });

  it("dedupes findings by id, sorts by severity and keeps the top N", () => {
    const raw = [f("m1", "minor"), f("b1", "blocking"), f("m1", "minor"), f("x1", "major"), f("i1", "info"), f("x2", "major"), { not: "a finding" }];
    expect(rankFindings(raw).map((x) => x.id)).toEqual(["b1", "x1", "x2", "m1", "i1"]);
    const top = evaluateOutcome(config({ topFindings: 2 }), { findings: raw }, state());
    expect(top.findings.map((x) => x.id)).toEqual(["b1", "x1"]);
    // Rules count every finding, not just the top N.
    expect(evaluateOutcome(config({ topFindings: 1, rules: [{ value: "not_ready", when: { findings: { severity: ["minor"], min: 1 } } }] }), { findings: raw }, state()).value).toBe("not_ready");
  });

  it("with topFindingsKinds, caps only those kinds and keeps every other finding", () => {
    const raw = [f("w1", "major", { kind: "weakness" }), f("w2", "major", { kind: "weakness" }), f("w3", "major", { kind: "weakness" }), f("len", "major", { kind: "page_limit" }), f("rig", "minor", { kind: "rigor" })];
    const o = evaluateOutcome(config({ topFindings: 2, topFindingsKinds: ["weakness"] }), { findings: raw }, state());
    expect(o.findings.map((x) => x.id)).toEqual(["w1", "w2", "len", "rig"]);
  });

  it("a blocked or incomplete outcome drops the decide step's rationale", () => {
    const blocked = { missing: [{ key: "consent", label: "Written consent" }], items: [] };
    expect(evaluateOutcome(config(), { blocked: [blocked], value: "ready", rationale: "Criteria met because…" }, state()).rationale).toBe("");
    expect(evaluateOutcome(config(), { value: "ready", rationale: "Criteria met because…" }, state({ steps: { check: { status: "failed" } } })).rationale).toBe("");
  });

  it("guards replace a decided value the hard rules forbid, and say why", () => {
    const guards = [{ values: ["ready"], instead: "ready_after_fixes", when: { anyOf: [{ findings: { severity: ["blocking" as const], min: 1 } }, { disagreements: { min: 1, blocking: true } }] }, reason: "an unresolved blocking finding." }];
    const withBlocking = evaluateOutcome(config({ guards }), { value: "ready", rationale: "Looks fine.", findings: [f("b", "blocking")] }, state());
    expect(withBlocking).toMatchObject({ value: "ready_after_fixes", valueLabel: "Ready after fixes" });
    expect(withBlocking.rationale).toBe("Changed from “Ready” to “Ready after fixes”: an unresolved blocking finding.\n\nLooks fine.");
    expect(evaluateOutcome(config({ guards }), { value: "ready", disagreements: [disagreement(true)] }, state()).value).toBe("ready_after_fixes");
    // Values the guard does not name, and values with nothing blocking, stand.
    expect(evaluateOutcome(config({ guards }), { value: "not_ready", findings: [f("b", "blocking")] }, state()).value).toBe("not_ready");
    expect(evaluateOutcome(config({ guards }), { value: "ready", rationale: "Fine.", findings: [f("m", "major")] }, state())).toMatchObject({ value: "ready", rationale: "Fine." });
  });

  it("lets a rescore replace the earlier score for the same item", () => {
    const merged = mergeScores([score("factor_1", 5), score("overall_impact", 6), score("overall_impact", 3, "agree2")]);
    expect(merged.map((s) => [s.item, s.median, s.nodeId])).toEqual([
      ["factor_1", 5, "agree1"],
      ["overall_impact", 3, "agree2"],
    ]);
    const nih = config({
      values: [
        { key: "high_impact", label: "High" },
        { key: "low_impact", label: "Low" },
      ],
      rules: [{ value: "high_impact", when: { score: { item: "overall_impact", stat: "median", op: "<=", value: 3 } } }],
      fallback: "low_impact",
    });
    expect(evaluateOutcome(nih, { scores: [score("overall_impact", 6)] }, state()).value).toBe("low_impact");
    expect(evaluateOutcome(nih, { scores: [score("overall_impact", 6), score("overall_impact", 3, "agree2")] }, state()).value).toBe("high_impact");
  });

  it("resolves the requirement sets it cites, leaving out unknown keys", () => {
    const o = evaluateOutcome(config({ requirementSets: ["nih-page-limits", "nope"] }), {}, state());
    expect(o.requirementSets).toEqual([{ key: "nih-page-limits", title: "NIH page limits", effective: "2025-01-25", checked: "2026-10-08", url: "https://grants.nih.gov", verifyNote: "Verify before relying." }]);
  });
});

describe("signOutcome", () => {
  const base = (): Outcome => evaluateOutcome(config(), {}, state());

  it("approve makes it final with who, when, role and record", () => {
    const o = signOutcome(base(), decision("approve", { edits: { record: { approver: "Ann" } } }));
    expect(o).toMatchObject({ value: "ready", advisory: false, verdict: "approve", signedBy: "sup@example.com", signedAt: "2026-10-08T12:00:00.000Z", signedRole: "Supervisor", record: { approver: "Ann" }, originalValue: null });
  });

  it("an edit replaces the value and keeps the original", () => {
    const o = signOutcome(base(), decision("edit", { edits: { outcomeValue: "not_ready" } }));
    expect(o).toMatchObject({ value: "not_ready", valueLabel: "Not ready", originalValue: "ready", advisory: false, verdict: "edit" });
  });

  it("reject records who rejected it and stays advisory", () => {
    const o = signOutcome(base(), decision("reject"));
    expect(o).toMatchObject({ value: "ready", advisory: true, verdict: "reject", signedBy: "sup@example.com", signedRole: null, record: {} });
  });
});
