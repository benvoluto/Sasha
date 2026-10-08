import { describe, expect, it } from "vitest";
import { compileWorkflow } from "@/lib/workflow/compile";
import { NODE_SPEC_INDEX } from "@/lib/workflow/registry";
import { RequirementRef } from "@/lib/workflow/node-specs/generic";
import { validateGraph } from "@/lib/workflow/validate";
import { fileTypes } from "./files";
import { builtInWorkflows, requirementItem, requirementSet, requirementSetsForType, typePolicy, workflowsForType } from "./workflows";

const all = builtInWorkflows();
const stepsOf = (node: string) => all.flatMap((w) => w.steps.filter((s) => s.node === node).map((s) => ({ w, s, config: compileWorkflow(w).nodes.find((n) => n.id === s.id)!.config })));

describe("built-in workflows", () => {
  it("ships the three generic workflows and twelve type workflows", () => {
    expect(all.filter((w) => w.kind === "generic").map((w) => w.key)).toEqual(["draft-all", "restructure", "source-coverage"]);
    expect(all.filter((w) => w.kind === "type")).toHaveLength(12);
    expect(all.filter((w) => w.fallback).map((w) => w.key)).toEqual(["type-general-report"]);
  });

  it.each(all.map((w) => [w.key, w] as const))("%s compiles to a graph with no validation errors", (_key, w) => {
    const graph = compileWorkflow(w);
    const errors = validateGraph(graph).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
    // Every step's own settings parse against its node type as given (defaults filled in).
    for (const n of graph.nodes) expect(NODE_SPEC_INDEX[n.type].config.safeParse(n.config).success, `${w.key}.${n.id}`).toBe(true);
    expect(w.provenance).toEqual({ source: "docs/workflows-by-document-type.md", checked: "2026-10-08" });
  });

  it("names only catalog types, and every in-catalog type resolves to its own type workflow", () => {
    const keys = new Set(fileTypes().map((t) => t.key));
    for (const w of all) for (const k of w.appliesTo) expect(keys.has(k), `${w.key}: ${k}`).toBe(true);
    expect(keys.size).toBe(12);
    for (const k of keys) {
      const typed = workflowsForType(k).filter((w) => w.kind === "type");
      expect(typed, k).toHaveLength(1);
      expect(typed[0].appliesTo).toContain(k);
    }
    // A type with no workflow of its own gets the general report's.
    expect(workflowsForType("some-new-type").map((w) => w.key)).toEqual(["draft-all", "restructure", "source-coverage", "type-general-report"]);
    expect(workflowsForType(null).every((w) => w.kind === "generic")).toBe(true);
  });

  it("gives every review two or three reviewers with distinct briefs, and a different brief set per workflow", () => {
    const reviews = stepsOf("step.review");
    expect(reviews.length).toBeGreaterThan(5);
    for (const { w, s, config } of reviews) {
      const briefs = (config.reviewers as Array<{ brief: string }>).map((r) => r.brief.trim().toLowerCase());
      expect(briefs.length, `${w.key}.${s.id}`).toBeGreaterThanOrEqual(2);
      expect(briefs.length).toBeLessThanOrEqual(3);
      expect(new Set(briefs).size).toBe(briefs.length);
      for (const b of briefs) expect(b.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("keeps each decide step's values equal to the outcome values", () => {
    for (const { w, config } of stepsOf("step.decide")) {
      expect([...(config.values as string[])].sort(), w.key).toEqual(w.outcome.values.map((v) => v.key).sort());
    }
  });

  it("wires a gate's blocked output into the outcome and its pass into the steps it guards", () => {
    for (const w of all) {
      const gate = w.steps.find((s) => s.node === "step.gate");
      if (!gate) continue;
      const out = w.steps.find((s) => s.node === "outcome.report")!;
      expect(out.in.blocked, w.key).toBe(`${gate.id}.blocked`);
      expect(w.steps.some((s) => s.in.after === `${gate.id}.pass`), w.key).toBe(true);
      // The outcome itself must run when blocked.
      expect(out.in.after).toBeUndefined();
    }
  });

  it("runs a decide step only after the gate passes, and a step fed by a branch only when that branch is taken", () => {
    for (const w of all) {
      const gate = w.steps.find((s) => s.node === "step.gate");
      const refs = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
      for (const s of w.steps) {
        if (s.node === "step.decide" && gate) expect(refs(s.in.after), `${w.key}.${s.id}`).toContain(`${gate.id}.pass`);
        // Optional inputs don't skip a step when their branch is not taken: an `after` on the branch must.
        const branches = Object.entries(s.in)
          .filter(([port]) => port !== "after")
          .flatMap(([, v]) => refs(v))
          .filter((r) => w.steps.find((x) => x.id === r.split(".")[0])?.node === "logic.if");
        for (const b of branches) expect(refs(s.in.after), `${w.key}.${s.id}`).toContain(b);
      }
    }
  });

  it("enforces the spec's hard rules on blocking findings in code, not only in the decide guidance", () => {
    const guards = (key: string) => (stepsOf("outcome.report").find(({ w }) => w.key === key)!.config.guards as Array<{ values: string[]; instead: string }>).map((g) => [g.values, g.instead]);
    expect(guards("type-design-doc")).toEqual([[["approve"], "approve_with_changes"]]);
    expect(guards("type-fie")).toEqual([[["criteria_met", "criteria_met_no_need"], "insufficient_evidence"]]);
  });

  it("puts a checkpoint step in each workflow that names one, with its role", () => {
    for (const w of all) {
      const cps = compileWorkflow(w).nodes.filter((n) => n.type === "checkpoint");
      if (!w.checkpoint) expect(cps, w.key).toHaveLength(0);
      else {
        expect(cps, w.key).toHaveLength(1);
        expect(cps[0].config.role).toBe(w.checkpoint.role);
      }
    }
  });

  it("resolves every requirement reference and requirement set", () => {
    for (const w of all) for (const k of w.requirementSets) expect(requirementSet(k), `${w.key}: ${k}`).not.toBeNull();
    for (const { w, config } of stepsOf("step.compute")) {
      for (const c of config.checks as Array<{ requirement?: string | null; requirementSet?: string | null }>) {
        if (c.requirement) {
          expect(RequirementRef.safeParse(c.requirement).success).toBe(true);
          expect(requirementItem(c.requirement), `${w.key}: ${c.requirement}`).not.toBeNull();
        }
        if (c.requirementSet) expect(requirementSet(c.requirementSet), w.key).not.toBeNull();
      }
    }
    for (const { w, config } of stepsOf("step.review")) {
      if (config.criteriaFrom) expect(requirementSet(config.criteriaFrom as string)!.items.some((i) => i.kind === "criterion"), w.key).toBe(true);
    }
    for (const { config } of stepsOf("requirements.read")) for (const k of config.sets as string[]) expect(requirementSet(k)).not.toBeNull();
  });

  it("uses only section keys of the types the workflow applies to", () => {
    const types = new Map(fileTypes().map((t) => [t.key, new Set(t.sections.map((s) => s.key))]));
    const keysIn = (config: Record<string, unknown>): string[] => {
      const out: string[] = [];
      const walk = (v: unknown, key = "") => {
        if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
        else if (typeof v === "string" && ["specKeys", "sectionKeys", "fromSpecKeys", "toSpecKeys", "appliesTo"].includes(key)) out.push(v);
      };
      walk(config);
      return out;
    };
    for (const w of all.filter((x) => x.kind === "type")) {
      const allowed = new Set(w.appliesTo.flatMap((k) => [...types.get(k)!]));
      for (const s of w.steps) for (const k of keysIn(s.config)) expect(allowed.has(k), `${w.key}.${s.id}: ${k}`).toBe(true);
    }
  });
});

describe("requirement sets and policies", () => {
  it("dates every set to the doc's check and keeps the verify note", () => {
    for (const k of ["tx-19tac-89-1040", "tx-19tac-89-1011", "idea-evaluation-34cfr", "nih-page-limits", "nih-simplified-review", "nih-ai-and-review-policy", "equator-reporting-guidelines", "diataxis-framework"]) {
      const s = requirementSet(k)!;
      expect(s, k).not.toBeNull();
      expect(s.checked).toBe("2026-10-08");
      expect(s.verifyNote).toMatch(/^Verify before relying/);
    }
    expect(requirementSet("equator-reporting-guidelines")!.provenance.license).toBe("Pointer only; checklist text not reproduced");
    expect(requirementSet("equator-reporting-guidelines")!.items.every((i) => i.kind === "guideline")).toBe(true);
    expect(requirementSetsForType("fie").map((s) => s.key).sort()).toEqual(["idea-evaluation-34cfr", "tx-19tac-89-1011", "tx-19tac-89-1040"]);
  });

  it("states the doc's limits and deadlines", () => {
    expect(requirementItem("nih-page-limits#specific-aims")!.item).toMatchObject({ value: 1, unit: "pages" });
    expect(requirementItem("nih-page-limits#research-strategy-12")!.item).toMatchObject({ value: 12, appliesTo: { activityCodes: ["R01", "R15", "U01"] } });
    expect(requirementItem("nih-page-limits#research-strategy-6")!.item).toMatchObject({ value: 6, appliesTo: { activityCodes: ["R03", "R21"] } });
    expect(requirementItem("tx-19tac-89-1011#fie-report")!.item).toMatchObject({ kind: "deadline", value: 45, unit: "school_days" });
    expect(requirementItem("tx-19tac-89-1011#ard-decision")!.item).toMatchObject({ value: 30, unit: "calendar_days" });
    expect(requirementItem("tx-19tac-89-1011#parent-copy")!.item).toMatchObject({ value: 5, unit: "school_days" });
    expect(requirementSet("nih-simplified-review")!.effective).toBe("2025-01-25");
  });

  it("turns draft-all off for NIH with the NOT-OD-25-132 reason, and makes the FIE sensitive with public domains", () => {
    const nih = typePolicy("nih-specific-aims-research-strategy", "grant");
    expect(nih.draftAll).toMatchObject({ enabled: false });
    expect(nih.draftAll!.reason).toMatch(/NOT-OD-25-132/);
    expect(nih.draftAll!.acknowledge.length).toBeGreaterThan(10);
    const fie = typePolicy("fie", "clinical");
    expect(fie.sensitive).toBe(true);
    expect(fie.webDomains).toEqual(expect.arrayContaining(["law.cornell.edu", "tea.texas.gov", "ed.gov"]));
    expect(typePolicy("proposal", "business").sensitive).toBe(false);
    expect(typePolicy("some-clinical-type", "clinical").sensitive).toBe(true);
  });
});
