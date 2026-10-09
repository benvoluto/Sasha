// Phase 8 catalog-a types (grants, business, career, academic): each type file
// parses and stays within the classifier budget, its workflow file builds into
// a valid graph that keeps the shared structural rules, and its requirement
// sets resolve. Types and workflows are read from their files (not only the
// bundles) so a stale bundle cannot hide a broken file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "@/lib/workflow/compile";
import { NODE_SPEC_INDEX } from "@/lib/workflow/registry";
import { validateGraph } from "@/lib/workflow/validate";
import { parseRequirementSet } from "./requirements-schema";
import { parseDefinition, type DocumentTypeDefinition } from "./schema";
import { parseWorkflowDefinition, type WorkflowDefinition } from "./workflow-schema";
import { requirementItem, requirementSetsForType, workflowsForType } from "./workflows";

const DIR = join(process.cwd(), "src/catalog");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(DIR, path), "utf8"));

/** Type key → its workflow key and the requirement sets that must apply to it. */
const TYPES: Record<string, { workflow: string; sets: string[] }> = {
  "nsf-project-description": { workflow: "type-nsf", sets: ["nsf-pappg"] },
  "foundation-letter-of-inquiry": { workflow: "type-foundation-loi", sets: [] },
  "funder-progress-report": { workflow: "type-funder-progress-report", sets: ["uniform-guidance-reporting"] },
  "strategy-memo": { workflow: "type-strategy-memo", sets: [] },
  "resume-cv": { workflow: "type-resume-cv", sets: [] },
  "cover-letter": { workflow: "type-cover-letter", sets: [] },
  "literature-review": { workflow: "type-literature-review", sets: ["equator-reporting-guidelines"] },
  "response-to-reviewers": { workflow: "type-response-to-reviewers", sets: ["nih-page-limits", "nih-ai-and-review-policy"] },
};
const SETS = ["nsf-pappg", "uniform-guidance-reporting", "nih-page-limits", "equator-reporting-guidelines", "nih-ai-and-review-policy", "nih-simplified-review"];

function typeOf(key: string): DocumentTypeDefinition {
  const r = parseDefinition(readJson(`types/${key}.json`));
  if (!r.ok) throw new Error(`${key}: ${r.errors.join("; ")}`);
  return r.definition;
}
function workflowOf(key: string): WorkflowDefinition {
  const r = parseWorkflowDefinition(readJson(`workflows/${key}.json`));
  if (!r.ok) throw new Error(`${key}: ${r.errors.join("; ")}`);
  return r.definition;
}

const entries = Object.entries(TYPES);
const ownWorkflows = entries.map(([, t]) => workflowOf(t.workflow));

describe("catalog-a types", () => {
  it.each(entries)("%s parses, with 5-12 sections and elements on every required section", (key) => {
    const t = typeOf(key);
    expect(t.key).toBe(key);
    expect(t.sections.length).toBeGreaterThanOrEqual(5);
    expect(t.sections.length).toBeLessThanOrEqual(12);
    for (const s of t.sections) {
      if (s.required) expect(s.elements.length, `${key}.${s.key}`).toBeGreaterThanOrEqual(2);
      if (s.scaffold) expect(s.renderer, `${key}.${s.key}`).toBe("static");
      expect(s.order % 10, `${key}.${s.key}`).toBe(0);
    }
    expect(t.provenance.retrieved).toBe("2026-10-08");
    expect(t.provenance.license.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s has 3-6 rubric criteria whose appliesTo names its own sections", (key) => {
    const t = typeOf(key);
    expect(t.rubric.length).toBeGreaterThanOrEqual(3);
    expect(t.rubric.length).toBeLessThanOrEqual(6);
    const sections = new Set(t.sections.map((s) => s.key));
    for (const c of t.rubric) for (const k of c.appliesTo ?? []) expect(sections.has(k), `${key}.${c.key}: ${k}`).toBe(true);
  });

  it.each(entries)("%s stays within the classifier budget (summary + signals <= 850 chars)", (key) => {
    const t = typeOf(key);
    expect(t.signals.length).toBeGreaterThanOrEqual(10);
    expect(t.signals.length).toBeLessThanOrEqual(18);
    for (const s of t.signals) expect(s.length, s).toBeLessThanOrEqual(60);
    expect(t.summary.length + t.signals.join("; ").length).toBeLessThanOrEqual(850);
  });

  it("names the NSF data plan the Data Management and Sharing Plan (DMSP)", () => {
    const t = typeOf("nsf-project-description");
    expect(t.title).toMatch(/Data Management and Sharing Plan/);
    expect(t.signals).toContain("DMSP");
    const dmsp = t.sections.find((s) => s.key === "data-management-and-sharing-plan")!;
    expect(dmsp.required).toBe(true);
    expect(dmsp.guidance).toMatch(/Research\.gov/);
    expect(JSON.stringify(t)).not.toMatch(/Data Management Plan\b/);
    expect(t.sections.find((s) => s.key === "broader-impacts")!.heading).toBe("Broader Impacts");
  });

  it("keeps candidate facts tied to the master history in the career types", () => {
    for (const key of ["resume-cv", "cover-letter"]) expect(typeOf(key).preamble, key).toMatch(/master/);
  });
});

describe("catalog-a workflows", () => {
  it.each(entries)("%s has its own type workflow", (key, { workflow }) => {
    const w = workflowOf(workflow);
    expect(w.kind).toBe("type");
    expect(w.appliesTo).toEqual([key]);
    expect(w.provenance).toEqual({ source: "docs/workflows-by-document-type.md", checked: "2026-10-08" });
    // And the bundle (npm run catalog:build) offers it to documents of the type.
    expect(workflowsForType(key).filter((x) => x.kind === "type").map((x) => x.key)).toEqual([workflow]);
  });

  it.each(entries)("%s compiles with no validation errors and every step config parses", (key, { workflow }) => {
    const w = workflowOf(workflow);
    const graph = compileWorkflow(w);
    expect(validateGraph(graph).filter((i) => i.severity === "error")).toEqual([]);
    for (const n of graph.nodes) expect(NODE_SPEC_INDEX[n.type]?.config.safeParse(n.config).success, `${w.key}.${n.id}`).toBe(true);
    // Section keys in step configs are the type's own.
    const sections = new Set(typeOf(key).sections.map((s) => s.key));
    const walk = (v: unknown, k = ""): string[] =>
      Array.isArray(v) ? v.flatMap((x) => walk(x, k)) : v && typeof v === "object" ? Object.entries(v).flatMap(([kk, x]) => walk(x, kk)) : typeof v === "string" && ["specKeys", "sectionKeys", "fromSpecKeys", "toSpecKeys", "appliesTo"].includes(k) ? [v] : [];
    for (const s of w.steps) for (const sk of walk(s.config)) expect(sections.has(sk), `${w.key}.${s.id}: ${sk}`).toBe(true);
  });

  it.each(ownWorkflows.map((w) => [w.key, w] as const))("%s keeps the gate, decide and checkpoint rules", (_k, w) => {
    const out = w.steps.filter((s) => s.node === "outcome.report");
    expect(out).toHaveLength(1);
    expect(out[0].in.after).toBeUndefined();
    const gate = w.steps.find((s) => s.node === "step.gate");
    if (gate) {
      expect(out[0].in.blocked).toBe(`${gate.id}.blocked`);
      expect(w.steps.some((s) => s.in.after === `${gate.id}.pass`)).toBe(true);
    }
    const graph = compileWorkflow(w);
    for (const n of graph.nodes.filter((x) => x.type === "step.decide")) {
      expect([...(n.config.values as string[])].sort()).toEqual(w.outcome.values.map((v) => v.key).sort());
      if (gate) expect(w.steps.find((s) => s.id === n.id)!.in.after).toBe(`${gate.id}.pass`);
    }
    const cps = graph.nodes.filter((n) => n.type === "checkpoint");
    expect(cps).toHaveLength(w.checkpoint ? 1 : 0);
    if (w.checkpoint) expect(cps[0].config.role).toBe(w.checkpoint.role);
  });

  it("gives each review 2-3 distinct briefs, and no two reviews the same brief set", () => {
    const sets: string[] = [];
    for (const w of ownWorkflows) {
      for (const n of compileWorkflow(w).nodes.filter((x) => x.type === "step.review")) {
        const briefs = (n.config.reviewers as Array<{ brief: string }>).map((r) => r.brief.trim().toLowerCase());
        expect(briefs.length).toBeGreaterThanOrEqual(2);
        expect(briefs.length).toBeLessThanOrEqual(3);
        expect(new Set(briefs).size).toBe(briefs.length);
        for (const b of briefs) expect(b.length).toBeGreaterThanOrEqual(20);
        sets.push([...briefs].sort().join("|"));
      }
    }
    expect(new Set(sets).size).toBe(sets.length);
  });

  it("resolves every requirement a compute step cites", () => {
    for (const w of ownWorkflows) {
      for (const n of compileWorkflow(w).nodes.filter((x) => x.type === "step.compute")) {
        for (const c of n.config.checks as Array<{ requirement?: string | null }>) if (c.requirement) expect(requirementItem(c.requirement), `${w.key}: ${c.requirement}`).not.toBeNull();
      }
    }
  });
});

describe("catalog-a requirement sets", () => {
  it.each(SETS)("%s parses from its file, is read from the rules and dated", (key) => {
    const r = parseRequirementSet(readJson(`requirements/${key}.json`));
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(r.set.key).toBe(key);
    expect(r.set.inferred).toBe(false);
    expect(r.set.provenance.url).toMatch(/^https:\/\//);
    expect(r.set.checked).toBe("2026-10-08");
    expect(r.set.verifyNote).toMatch(/^Verify before relying/);
  });

  it.each(entries)("%s resolves its requirement sets via requirementSetsForType", (key, { workflow, sets }) => {
    const keys = requirementSetsForType(key).map((s) => s.key);
    for (const s of sets) expect(keys, key).toContain(s);
    for (const s of workflowOf(workflow).requirementSets) expect(keys, `${workflow}: ${s}`).toContain(s);
  });

  it("states the NSF, federal reporting and NIH resubmission numbers", () => {
    expect(requirementItem("nsf-pappg#project-description-15")!.item).toMatchObject({ kind: "limit", value: 15, unit: "pages" });
    expect(requirementItem("nsf-pappg#prior-support-5")!.item).toMatchObject({ value: 5, unit: "pages" });
    expect(requirementItem("nsf-pappg#dmsp-research-gov")!.item.text).toMatch(/April 27, 2026/);
    expect(requirementItem("uniform-guidance-reporting#final-report-due")!.item).toMatchObject({ kind: "deadline", value: 120, unit: "calendar_days", citation: "2 CFR 200.329(c)(1)" });
    expect(requirementItem("uniform-guidance-reporting#prior-approval-scope")!.item.citation).toBe("2 CFR 200.308(f)(1)");
    expect(requirementItem("nih-page-limits#resubmission-introduction")!.item).toMatchObject({ value: 1, unit: "pages" });
    const prisma = requirementItem("equator-reporting-guidelines#prisma-2020")!.item;
    expect(prisma.kind).toBe("guideline");
    expect(prisma.text).toMatch(/not reproduced/);
  });
});
