import { describe, expect, it } from "vitest";
import { setsDraft, typeDraft, workflowDraft } from "./__fixtures__/learn-reply";
import {
  confidenceFor,
  headingDifferences,
  mergeDifferences,
  normalizeRequirementSets,
  normalizeType,
  normalizeWorkflow,
  parseJsonText,
  remapSetKeys,
  teamSetKey,
  validateDraft,
  workflowRules,
  type NormalizeContext,
} from "./validate";
import { parseWorkflowDefinition, type WorkflowDefinition } from "@/catalog/workflow-schema";
import { builtInWorkflow } from "@/catalog/workflows";

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({ takenTypeKeys: new Set(["proposal"]), takenSetKeys: new Set(["nih-page-limits"]), exampleCount: 2, today: "2026-10-08", ...over });

function normalized(type = typeDraft(), workflow: Record<string, unknown> = workflowDraft(), sets: unknown[] = setsDraft(), c = ctx()) {
  const t = normalizeType(type, c);
  const { sets: s, keyMap } = normalizeRequirementSets(sets, String(t.key), c);
  return { type: t, workflow: normalizeWorkflow(workflow, String(t.key), keyMap, c), sets: s };
}

const wf = (over: Record<string, unknown> = {}): WorkflowDefinition => {
  const r = parseWorkflowDefinition({ ...normalized().workflow, ...over });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.definition;
};

describe("normalization", () => {
  it("owns the type's key, version, provenance and aliases; the author's title and family win", () => {
    const t = normalizeType(typeDraft({ key: "whatever", version: 7, aliases: ["proposal"] }), ctx({ title: "Proposal", family: "grant", exampleCount: 1, takenTypeKeys: new Set(["proposal", "proposal-2"]) }));
    expect(t).toMatchObject({ key: "proposal-3", version: 1, title: "Proposal", family: "grant", aliases: [], provenance: { source: "Learned from 1 example", url: "", license: "Team", retrieved: "2026-10-08" } });
    expect(normalizeType({}, ctx()).provenance).toMatchObject({ source: "Learned from 2 examples" });
  });

  it("makes a section only some examples show optional (keep what they share)", () => {
    const t = normalizeType(typeDraft(), ctx(), [{ path: "type.sections.approval", note: "", from: [], shared: false }]);
    expect((t.sections as Array<{ key: string; required?: boolean }>).find((s) => s.key === "approval")!.required).toBe(false);
    // With one example every part is shared.
    const one = normalizeType(typeDraft(), ctx({ exampleCount: 1 }), [{ path: "type.sections.approval", note: "", from: [], shared: false }]);
    expect((one.sections as Array<{ key: string; required?: boolean }>).find((s) => s.key === "approval")!.required).toBeUndefined();
  });

  it("prefixes inferred set keys, keeps them unique, forces inferred with no URL, and remaps the workflow's references", () => {
    expect(teamSetKey("team-limits", "x", new Set(["team-limits"]))).toBe("team-limits-2");
    expect(teamSetKey("", "equipment-request", new Set())).toBe("team-equipment-request");
    const n = normalized();
    expect(n.sets[0]).toMatchObject({ key: "team-approvals", inferred: true, provenance: { url: "", license: "Team" }, appliesTo: ["equipment-request"], effective: "", checked: "2026-10-08" });
    expect(n.workflow).toMatchObject({ kind: "type", appliesTo: ["equipment-request"], fallback: false, requirementSets: ["team-approvals"], provenance: { source: "Learned from 2 examples", checked: "2026-10-08" } });
    const req = (n.workflow.steps as Array<{ id: string; config: { sets?: string[] } }>).find((s) => s.id === "req")!;
    expect(req.config.sets).toEqual(["team-approvals"]);
    expect(remapSetKeys({ a: ["x#i", "x", "y"] }, new Map([["x", "team-x"]]))).toEqual({ a: ["team-x#i", "team-x", "y"] });
    expect(normalizeRequirementSets(Array.from({ length: 9 }, () => setsDraft()[0]), "t", ctx()).sets).toHaveLength(4);
  });

  it("reads JSON text, with or without a code fence", () => {
    expect(parseJsonText('```json\n{"a":1}\n```', "type")).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseJsonText("{oops", "type");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^type: not valid JSON/);
  });
});

describe("validateDraft", () => {
  it("passes the fixture's type, workflow and inferred set", () => {
    const n = normalized();
    const r = validateDraft(n.type, n.workflow, n.sets);
    expect(r.validation).toEqual({ type: [], workflow: [], graph: [], requirementSets: [] });
    expect(r.type?.key).toBe("equipment-request");
    expect(r.requirementSets[0].inferred).toBe(true);
  });

  it("reports schema errors per part", () => {
    const n = normalized(typeDraft({ sections: [] }));
    const r = validateDraft(n.type, { ...n.workflow, steps: [] }, [{ ...n.sets[0], items: [] }]);
    expect(r.validation.type[0]).toMatch(/^sections/);
    expect(r.validation.workflow.length).toBeGreaterThan(0);
    expect(r.validation.requirementSets[0]).toMatch(/^requirementSets\.team-approvals\.items/);
    // A set that claims to be read from rules.
    const notInferred = validateDraft(n.type, undefined, [{ ...n.sets[0], inferred: false, provenance: { source: "x", url: "https://example.org/rules", license: "Team" } }]);
    expect(notInferred.validation.requirementSets.join(" ")).toMatch(/inferred and has no URL/);
  });

  it("reports graph errors (a required input left unconnected)", () => {
    const n = normalized();
    const steps = (n.workflow.steps as Array<Record<string, unknown>>).map((s) => (s.id === "agr" ? { ...s, in: {} } : s));
    const r = validateDraft(n.type, { ...n.workflow, steps }, n.sets);
    expect(r.validation.graph.join(" ")).toMatch(/agr: .*connect/);
  });
});

describe("workflowRules", () => {
  const type = { key: "equipment-request", sections: typeDraft().sections as Array<{ key: string }> } as never;
  const inferred = new Set(["team-approvals"]);
  const steps = () => normalized().workflow.steps as Array<Record<string, unknown> & { id: string; in?: Record<string, unknown>; config?: Record<string, unknown> }>;
  const withStep = (id: string, patch: Record<string, unknown>) => steps().map((s) => (s.id === id ? { ...s, ...patch } : s));

  it("accepts the fixture", () => {
    expect(workflowRules(wf(), type, inferred)).toEqual([]);
  });

  it("refuses nodes outside the learned set (no drafting, no web search, no writes)", () => {
    const errors = workflowRules(wf({ steps: [...steps(), { id: "web", node: "web.find", in: { gaps: "chk.findings" } }] }), type, inferred);
    expect(errors.join(" ")).toMatch(/node "web.find" is not allowed/);
  });

  it("checks gate wiring: blocked into the outcome, pass before the guarded steps, no after on the outcome", () => {
    const out = steps().find((s) => s.id === "out")!;
    const { blocked: _b, ...unblocked } = out.in!;
    void _b;
    const e1 = workflowRules(wf({ steps: withStep("out", { in: unblocked }) }), type, inferred);
    expect(e1.join(" ")).toMatch(/wire the gate's blocked output/);
    const e2 = workflowRules(wf({ steps: withStep("out", { in: { ...out.in, after: "gate.pass" } }) }), type, inferred);
    expect(e2.join(" ")).toMatch(/takes no "after"/);
    const { after: _a, ...ungated } = steps().find((s) => s.id === "dec")!.in!;
    void _a;
    const e3 = workflowRules(wf({ steps: withStep("dec", { in: ungated }) }), type, inferred);
    expect(e3.join(" ")).toMatch(/decide step runs only after the gate passes/);
  });

  it("normalization wires a lone gate's blocked output into the outcome and drops the outcome's after", () => {
    const raw = workflowDraft();
    const rawSteps = raw.steps as Array<{ id: string; in?: Record<string, unknown> }>;
    const out = rawSteps.find((s) => s.id === "out")!;
    const { blocked: _b, ...unblocked } = out.in!;
    void _b;
    const broken = { ...raw, steps: rawSteps.map((s) => (s.id === "out" ? { ...s, in: { ...unblocked, after: "gate.pass" } } : s)) };
    const n = normalized(typeDraft(), broken);
    const fixed = (n.workflow.steps as Array<{ id: string; in: Record<string, unknown> }>).find((s) => s.id === "out")!;
    expect(fixed.in.blocked).toBe("gate.blocked");
    expect(fixed.in.after).toBeUndefined();
    expect(workflowRules(wf({ steps: n.workflow.steps }), type, inferred)).toEqual([]);
  });

  it("keeps decide values equal to the outcome values", () => {
    const errors = workflowRules(wf({ steps: withStep("dec", { config: { values: ["approve", "reject"], guidance: "x" } }) }), type, inferred);
    expect(errors.join(" ")).toMatch(/must equal the outcome values/);
  });

  it("wants distinct reviewer briefs that are not a catalog workflow's", () => {
    const same = { key: "a", label: "A", brief: "Judge whether the stated need justifies the spend for this department." };
    const dup = workflowRules(wf({ steps: withStep("rev", { config: { ...steps().find((s) => s.id === "rev")!.config, reviewers: [same, { ...same, key: "b" }] } }) }), type, inferred);
    expect(dup.join(" ")).toMatch(/different brief/);
    const nih = builtInWorkflow("type-nih")!.steps.find((s) => s.node === "step.review");
    if (nih) {
      const copied = workflowRules(wf({ steps: withStep("rev", { config: nih.config }) }), type, inferred);
      expect(copied.join(" ")).toMatch(/rather than reusing a catalog workflow/);
    }
  });

  it("needs one checkpoint step for a checkpoint, section keys of the type, and known requirement sets", () => {
    expect(workflowRules(wf({ checkpoint: { role: "Head", required: false }, steps: steps().filter((s) => s.id !== "cp") }), type, inferred).join(" ")).toMatch(/exactly one checkpoint step/);
    expect(workflowRules(wf({ checkpoint: null }), type, inferred).join(" ")).toMatch(/remove the checkpoint step/);
    const gate = steps().find((s) => s.id === "gate")!;
    const badKey = withStep("gate", { config: { inputs: [{ ...(gate.config!.inputs as object[])[0], specKeys: ["budget"] }] } });
    expect(workflowRules(wf({ steps: badKey }), type, inferred).join(" ")).toMatch(/"budget" is not one of the type's section keys/);
    expect(workflowRules(wf({ requirementSets: ["team-unknown"] }), type, inferred).join(" ")).toMatch(/unknown requirement set "team-unknown"/);
    // Compute and review criteria read catalog sets only.
    const compute = { id: "cmp", node: "step.compute", config: { checks: [{ kind: "length", key: "len", label: "Length", unit: "pages", requirement: "team-approvals#head_signs" }] }, in: { document: "doc.document" } };
    expect(workflowRules(wf({ steps: [...steps(), compute] }), type, inferred).join(" ")).toMatch(/must be a catalog requirement/);
  });
});

describe("differences and confidence", () => {
  const ex = (index: number, headings: string[]) => ({ index, headings: [{ level: 1, text: "Equipment request" }, ...headings.map((text) => ({ level: 2, text }))] });

  it("lists headings only some examples have", () => {
    const d = headingDifferences([ex(0, ["Summary", "Costs"]), ex(1, ["Summary", "2. Costs", "Risks"])]);
    expect(d).toEqual([{ aspect: "section", description: "“Risks” appears in one example.", examples: [1] }]);
    expect(headingDifferences([ex(0, ["A"])])).toEqual([]);
  });

  it("merges the model's differences without repeating a heading it already reported", () => {
    const merged = mergeDifferences([{ aspect: "section", description: "Only one has a “Risks” section.", examples: [1, 7] }], [ex(0, ["Summary"]), ex(1, ["Summary", "Risks"])]);
    expect(merged).toEqual([{ aspect: "section", description: "Only one has a “Risks” section.", examples: [1] }]);
    expect(mergeDifferences([{ aspect: "tone", description: "x", examples: [0] }], [ex(0, [])])).toEqual([]);
  });

  it("labels one example low, two medium unless they differ a lot, three or more high when they share structure", () => {
    expect(confidenceFor(1, [], [])).toMatchObject({ confidence: "low", reason: expect.stringMatching(/^One example/) });
    expect(confidenceFor(2, [], [{ path: "a", note: "", from: [], shared: true }]).confidence).toBe("medium");
    const big = Array.from({ length: 3 }, () => ({ aspect: "section" as const, description: "x", examples: [0] }));
    expect(confidenceFor(2, big, []).confidence).toBe("low");
    expect(confidenceFor(3, [], [{ path: "a", note: "", from: [], shared: true }]).confidence).toBe("high");
    expect(confidenceFor(4, big, []).confidence).toBe("medium");
  });
});
