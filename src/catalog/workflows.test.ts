import { describe, expect, it } from "vitest";
import { compileWorkflow } from "@/lib/workflow/compile";
import { NODE_SPEC_INDEX } from "@/lib/workflow/registry";
import { RequirementRef } from "@/lib/workflow/node-specs/generic";
import { validateGraph } from "@/lib/workflow/validate";
import type { Finding } from "@/lib/workflow/contract";
import type { OutcomeReportConfig } from "@/lib/workflow/node-specs/core";
import { evaluateOutcome } from "@/lib/workflow/outcome";
import { fileTypes } from "./files";
import { builtInWorkflows, requirementItem, requirementSet, requirementSetsForType, typePolicy, workflowsForType } from "./workflows";

const all = builtInWorkflows();
const stepsOf = (node: string) => all.flatMap((w) => w.steps.filter((s) => s.node === node).map((s) => ({ w, s, config: compileWorkflow(w).nodes.find((n) => n.id === s.id)!.config })));

describe("built-in workflows", () => {
  it("ships the three generic workflows and one type workflow per catalog type", () => {
    expect(all.filter((w) => w.kind === "generic").map((w) => w.key)).toEqual(["draft-all", "restructure", "source-coverage"]);
    // Counted against the catalog rather than hardcoded, so adding a type and its workflow needs no edit here.
    expect(all.filter((w) => w.kind === "type")).toHaveLength(fileTypes().length);
    expect(all.filter((w) => w.fallback).map((w) => w.key)).toEqual(["type-general-report"]);
  });

  it.each(all.map((w) => [w.key, w] as const))("%s compiles to a graph with no validation errors", (_key, w) => {
    const graph = compileWorkflow(w);
    const errors = validateGraph(graph).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
    // Every step's own settings parse against its node type as given (defaults filled in).
    for (const n of graph.nodes) expect(NODE_SPEC_INDEX[n.type].config.safeParse(n.config).success, `${w.key}.${n.id}`).toBe(true);
    // The resume workflow gained its Tailor step after Phase 9 (user decision 2026-10-09).
    expect(w.provenance).toEqual({ source: "docs/workflows-by-document-type.md", checked: w.key === "type-resume-cv" ? "2026-10-09" : "2026-10-08" });
  });

  it("names only catalog types, and every in-catalog type resolves to its own type workflow", () => {
    const keys = new Set(fileTypes().map((t) => t.key));
    for (const w of all) for (const k of w.appliesTo) expect(keys.has(k), `${w.key}: ${k}`).toBe(true);
    expect(keys.size).toBeGreaterThanOrEqual(12);
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

  it("keys hard outcome rules on the findings they are about, not on any blocking finding", () => {
    const finding = (kind: string, severity: Finding["severity"]): Finding => ({ id: kind, nodeId: "n", kind, severity, status: null, title: kind, detail: "", location: null, evidence: [], reviewer: null, verified: true, fix: "" });
    const outcome = (key: string, inputs: Record<string, unknown>) =>
      evaluateOutcome(stepsOf("outcome.report").find(({ w }) => w.key === key)!.config as OutcomeReportConfig, inputs, { workflowId: `builtin:${key}`, steps: {}, checkpoints: {}, labels: {} }).value;
    // Progress report: an agreed "unsatisfactory" is a gap, not missing sections.
    expect(outcome("type-funder-progress-report", { findings: [finding("blocking_verdict", "blocking")] })).toBe("gaps_found");
    expect(outcome("type-funder-progress-report", { findings: [finding("required_sections", "blocking")] })).toBe("sections_missing");
    // LOI: one reviewer's do_not_proceed is weighed by the decide step; only an eligibility failure forces it.
    expect(outcome("type-foundation-loi", { value: "proceed", findings: [finding("reviewer_disagreement", "blocking")] })).toBe("proceed");
    expect(outcome("type-foundation-loi", { value: "proceed", findings: [finding("geography", "blocking")] })).toBe("do_not_proceed");
    // Diátaxis reference: one unverified item among real mismatches is still out of sync; consistency-only means nothing was compared.
    expect(outcome("type-diataxis-reference", { findings: [finding("mismatch", "major"), finding("no_source", "minor")] })).toBe("out_of_sync");
    expect(outcome("type-diataxis-reference", { findings: [finding("no_source", "minor")] })).toBe("consistency_only");
    // Progress report: a final report's due date is not judged by the annual 90 days.
    const due = stepsOf("step.compute").find(({ w, s }) => w.key === "type-funder-progress-report" && s.id === "comp")!.config.checks as Array<{ kind: string; byKind?: { requirements: Record<string, string> } }>;
    expect(due.find((c) => c.kind === "deadline")!.byKind!.requirements).toEqual({
      annual: "uniform-guidance-reporting#annual-report-due",
      interim: "uniform-guidance-reporting#interim-report-due",
      final: "uniform-guidance-reporting#final-report-due",
    });
  });

  it("computes the resume match score in code and gives it to the decide step and the outcome", () => {
    const w = all.find((x) => x.key === "type-resume-cv")!;
    const step = (id: string) => w.steps.find((s) => s.id === id)!;
    expect(step("covb").in).toMatchObject({ items: "before.traced" });
    expect(step("cova").in).toMatchObject({ items: "after.traced" });
    for (const id of ["decide", "out"]) expect(step(id).in?.results, id).toEqual(expect.arrayContaining(["covb.results", "cova.results"]));
  });

  it("tailors the resume from the master history, waits for the author's lines, then reads the resume as left", () => {
    const w = all.find((x) => x.key === "type-resume-cv")!;
    const step = (id: string) => w.steps.find((s) => s.id === id)!;
    const graph = compileWorkflow(w);
    const config = (id: string) => graph.nodes.find((n) => n.id === id)!.config;
    expect(w.version).toBe(2);
    expect(step("tailor")).toMatchObject({ node: "tailor.lines", in: { document: "doc.document", sources: "src.sources", requirements: "before.traced" } });
    expect(config("tailor").excludeSources).toEqual(expect.arrayContaining(["job description", "job posting", "posting"]));
    // Bare "job" or "careers" would drop a master titled "Master resume (all jobs)" (narrowSources matches word starts).
    for (const id of ["before", "tailor", "truth"]) expect(config(id).excludeSources, id).not.toEqual(expect.arrayContaining(["job"]));
    expect(step("write")).toMatchObject({ node: "doc.write", in: { ops: "tailor.op" } });
    expect(config("write")).toMatchObject({ target: "editor", waitForResult: true });
    expect(step("doc2")).toMatchObject({ node: "doc.read", in: { after: "write.result" } });
    // Every step that reads the resume after tailoring reads it fresh.
    for (const id of ["after", "facts", "len", "fmt"]) expect(step(id).in?.document, id).toBe("doc2.document");
    // The posting is left out of the master-history traces in code, not only by the question.
    for (const id of ["before", "truth"]) expect(config(id).excludeSources, id).toEqual(expect.arrayContaining(["job posting", "posting", "vacancy"]));
    // ...and they read only the master history, as tailor does (not a reference letter or portfolio page).
    for (const id of ["before", "truth"]) expect(config(id).matchSources, id).toEqual(config("tailor").masterMatch);
    expect(config("truth").statuses).toEqual(expect.arrayContaining([expect.objectContaining({ key: "overstated", severity: "blocking" })]));
    expect(step("cp").in?.items).toEqual(["out.outcome", "write.lines"]);
    // The lines changed come from the author's accepted lines, counted in code (not the tailor step's proposed count).
    expect(step("chg")).toMatchObject({ node: "step.compute", in: { items: "write.lines", after: ["gate.pass", "write.result"] } });
    for (const id of ["decide", "out"]) expect(step(id).in?.results, id).toEqual(expect.arrayContaining(["chg.results"]));
    // The source the gate bound as the job is left out of every master-history step by id, whatever it is titled.
    for (const id of ["before", "tailor", "truth"]) {
      expect(step(id).in, id).toMatchObject({ gate: "gate.report" });
      expect(config(id).excludeBound, id).toEqual(["job"]);
    }
    for (const id of ["decide", "out"]) expect(step(id).in?.findings, id).toEqual(expect.arrayContaining(["tailor.findings", "truth.findings"]));
    expect(step("out").in?.tables).toEqual(expect.arrayContaining(["tailor.table", "write.table"]));
    // Gaps are listed by the priority the posting gives (a live run called a required gap preferred).
    expect(String(config("decide").guidance)).toMatch(/required and preferred apart/);
    // The departure note and the "tailoring not assessed" entry are gone.
    expect([...w.notes, ...w.notAssessed].join(" ")).not.toMatch(/departure|tailoring itself/i);
  });

  it("exempts an IEP need with a stated reason for no goal from the untraced flag", () => {
    const trace = stepsOf("step.trace").find(({ w, s }) => w.key === "type-iep" && s.id === "trace")!;
    expect(trace.config).toMatchObject({ bothWays: true, exemptField: "reason_no_goal" });
    const needs = stepsOf("step.extract").find(({ w, s }) => w.key === "type-iep" && s.id === "needs")!;
    expect((needs.config.fields as Array<{ name: string }>).map((f) => f.name)).toContain("reason_no_goal");
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
      for (const c of config.checks as Array<{ requirement?: string | null; requirementSet?: string | null; byKind?: { requirements: Record<string, string> } | null }>) {
        for (const ref of [c.requirement, ...Object.values(c.byKind?.requirements ?? {})]) {
          if (!ref) continue;
          expect(RequirementRef.safeParse(ref).success).toBe(true);
          expect(requirementItem(ref), `${w.key}: ${ref}`).not.toBeNull();
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
    for (const k of ["tx-19tac-89-1040", "tx-19tac-89-1011", "idea-evaluation-34cfr", "idea-iep-34cfr", "idea-discipline-34cfr", "nih-page-limits", "nih-simplified-review", "nih-ai-and-review-policy", "equator-reporting-guidelines", "diataxis-framework"]) {
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

  it("makes the IEP, reevaluation review and FBA sensitive, searching only public regulation and agency domains", () => {
    for (const key of ["iep", "reevaluation-review", "fba-bip"]) {
      const p = typePolicy(key, "clinical");
      expect(p.sensitive, key).toBe(true);
      expect(p.webDomains, key).toEqual(expect.arrayContaining(["law.cornell.edu", "ecfr.gov", "ed.gov"]));
      // Public sources only: no general search engines, social or student-information sites.
      for (const d of p.webDomains) expect(d, `${key}: ${d}`).toMatch(/(\.gov|cornell\.edu)$/);
    }
  });

  it("gives the Phase 8 clinical types their requirement sets, with the doc's IDEA rules", () => {
    expect(requirementSetsForType("iep").map((s) => s.key)).toContain("idea-iep-34cfr");
    expect(requirementSetsForType("fba-bip").map((s) => s.key)).toEqual(expect.arrayContaining(["idea-discipline-34cfr", "idea-iep-34cfr"]));
    expect(requirementSetsForType("reevaluation-review").map((s) => s.key)).toContain("idea-evaluation-34cfr");
    expect(requirementSetsForType("diataxis-reference").map((s) => s.key)).toEqual(["diataxis-framework"]);
    expect(requirementItem("idea-evaluation-34cfr#three-year")!.item).toMatchObject({ kind: "deadline", value: 3, unit: "years", citation: "34 CFR 300.303(b)(2)" });
    expect(requirementItem("idea-evaluation-34cfr#reed-questions")!.item.citation).toBe("34 CFR 300.305(a)(2)");
    expect(requirementItem("idea-evaluation-34cfr#review-without-consent")!.item.citation).toBe("34 CFR 300.300(d)(1)(i)");
    expect(requirementItem("idea-iep-34cfr#service-details")!.item.citation).toBe("34 CFR 300.320(a)(7)");
    expect(requirementItem("idea-iep-34cfr#initial-iep-meeting")!.item).toMatchObject({ value: 30, unit: "calendar_days" });
    expect(requirementItem("idea-discipline-34cfr#manifestation-determination")!.item).toMatchObject({ value: 10, unit: "school_days" });
    expect(requirementItem("idea-discipline-34cfr#fba-bip-when-manifestation")!.item.citation).toBe("34 CFR 300.530(f)(1)");
    // The Texas criteria stay a swappable set, dated to the 2026 amendment; FIE keeps its category criteria.
    expect(requirementSet("tx-19tac-89-1040")!.effective).toBe("2026-10-04");
    expect(requirementSet("tx-19tac-89-1040")!.items.filter((i) => i.kind === "criterion").map((i) => i.key)).toContain("other-health-impairment");
  });

  it("guards the Phase 8 clinical and technical outcomes in code", () => {
    const guards = (key: string) => (stepsOf("outcome.report").find(({ w }) => w.key === key)!.config.guards as Array<{ values: string[]; instead: string }>).map((g) => [g.values, g.instead]);
    expect(guards("type-reevaluation-review")).toEqual([[["no_additional_data"], "additional_data_needed"]]);
    expect(guards("type-fba-bip")).toEqual([[["plan_matches"], "gaps_found"]]);
    expect(guards("type-incident-postmortem")).toEqual([[["ready_to_publish"], "gaps_found"]]);
    // The REED's three-year date is computed in code from its requirement item.
    const due = stepsOf("step.compute").find(({ w, s }) => w.key === "type-reevaluation-review" && s.id === "due")!;
    expect((due.config.checks as Array<{ requirement?: string }>)[0].requirement).toBe("idea-evaluation-34cfr#three-year");
    // Clinical workflows end at a team checkpoint, never at the model's value.
    for (const key of ["type-iep", "type-reevaluation-review", "type-fba-bip"]) {
      const w = all.find((x) => x.key === key)!;
      expect(w.checkpoint?.required, key).toBe(true);
      expect(w.notes.join(" "), key).toMatch(/no student details/);
    }
  });
});
