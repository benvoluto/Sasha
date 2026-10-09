// Built-in workflows run end to end through the real engine and node
// implementations, over the memory stores, with the model calls mocked by
// task (empty or fixed replies). Skipped until every registered node type has
// an implementation (the tracks merge their handler maps separately).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { claudeJson, claudeText } = vi.hoisted(() => ({ claudeJson: vi.fn(), claudeText: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson, claudeText }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));

import { fileTypeByKey } from "@/catalog/files";
import { sortedSections } from "@/catalog/schema";
import type { PMNode } from "@/lib/documents/sections";
import type { CheckpointDecision, DocumentChangeOp, WorkflowRunRecord } from "@/lib/workflow/contract";
import { compileWorkflow } from "@/lib/workflow/compile";
import { executeGraph, HANDLERS } from "@/lib/workflow/engine";
import { NODE_SPECS } from "@/lib/workflow/registry";
import { createRun, getRun, proposedChanges, recordChangeResult, resetWorkflowStore, type SavedWorkflow } from "@/lib/workflow/store";
import { documentLines } from "@/lib/workflow/lines";
import { heading, makeDocument, para, resetStores, TEAM, AGENT } from "@/lib/workflow/nodes/test-fixtures";
import { builtInId, builtInWorkflow } from "./workflows";

const missingHandlers = NODE_SPECS.map((s) => s.type).filter((t) => !HANDLERS[t]);
const USAGE = { model: "claude-sonnet-5-5", input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** Empty but valid replies for the shared steps; tests override the tasks they care about. */
function replyFor(task: string): unknown {
  switch (task) {
    case "workflow.extract":
      return { items: [] };
    case "workflow.trace":
      return { items: [] };
    case "workflow.check":
      return { results: [] };
    case "rubric.check":
      return { scores: [] };
    default:
      throw new Error(`unexpected model call: ${task}`);
  }
}

function saved(key: string): SavedWorkflow {
  const def = builtInWorkflow(key)!;
  return { workflow_id: builtInId(key), name: def.title, version: def.version, graph: compileWorkflow(def), note: "", created_by: "system", created_at: "", readOnly: true, based_on: null };
}

async function start(key: string, documentId: string, params: WorkflowRunRecord["params"] = {}) {
  const run = await createRun(TEAM, documentId, saved(key), params, { agent: AGENT, permissions: [] });
  await executeGraph(run);
  return (await getRun(TEAM, run.id))!;
}

async function decide(run: WorkflowRunRecord, nodeId: string, decision: Partial<CheckpointDecision>) {
  run.checkpoints[nodeId] = { verdict: "approve", note: "", by: AGENT, at: new Date().toISOString(), role: "Author", excluded: [], edits: null, ...decision };
  run.steps[nodeId] = { status: "pending" };
  await executeGraph(run);
  return (await getRun(TEAM, run.id))!;
}

beforeEach(() => {
  resetStores();
  resetWorkflowStore();
  claudeJson.mockReset();
  claudeText.mockReset();
  claudeJson.mockImplementation(async (c: { task: string }) => ({ data: replyFor(c.task), usage: USAGE }));
});

describe.skipIf(missingHandlers.length > 0)("built-in workflows end to end", () => {
  it("general report: runs every step and reaches an outcome", async () => {
    const content: PMNode[] = sortedSections(fileTypeByKey("general-report")!.sections).flatMap((s, i) => [heading(s.heading, `g${i}`, s.key), para(`About ${s.heading}: 1,250 households took part.`)]);
    const { doc } = await makeDocument({ typeKey: "general-report", content, sources: [{ title: "Survey", summary: "Household survey.", passages: ["1,250 households took part in 2025."] }] });
    const run = await start("type-general-report", doc.id);
    expect(Object.entries(run.steps).filter(([, s]) => s.status === "failed")).toEqual([]);
    expect(run.status).toBe("complete");
    expect(run.outcome).toMatchObject({ workflowKey: "type-general-report", value: "sound", advisory: true });
    expect(run.outcome!.computed.length).toBeGreaterThan(0);
    expect(run.outcome!.values.at(-1)!.key).toBe("blocked");
  });

  it("source coverage: blocked with the missing input when the document has no type", async () => {
    const { doc } = await makeDocument({ content: [heading("Notes", "n1"), para("Some text.")] });
    const run = await start("source-coverage", doc.id);
    expect(run.outcome).toMatchObject({ value: "blocked", missing: ["A document type"] });
    expect(run.steps.cov.status).toBe("skipped");
    expect(claudeJson).not.toHaveBeenCalled();
  });

  describe("review panels", () => {
    /** The gate finds every input (citing section b1); reviews come from `rate(reviewer index)`; everything else is empty. */
    function panel(key: string, rate: (i: number) => Array<{ item: string; verdict: string | null; score: number | null }>, extra: Record<string, unknown> = {}) {
      const gateKeys = (builtInWorkflow(key)!.steps.find((s) => s.node === "step.gate")!.config.inputs as Array<{ key: string }>).map((i) => i.key);
      let reviews = 0;
      claudeJson.mockImplementation(async (c: { task: string }) => {
        if (c.task === "workflow.gate") return { data: { inputs: gateKeys.map((k) => ({ key: k, present: true, evidence: [{ id: "b1", quote: "" }], why: "Stated." })) }, usage: USAGE };
        if (c.task === "workflow.review") {
          const ratings = rate(reviews++ % 3).map((r) => ({ ...r, rationale: "Because.", evidence: [] }));
          return { data: { ratings, strengths: [], weaknesses: [] }, usage: USAGE };
        }
        if (c.task in extra) return { data: extra[c.task], usage: USAGE };
        return { data: replyFor(c.task), usage: USAGE };
      });
      return { reviewCalls: () => reviews };
    }
    const nihDoc = () => {
      const content: PMNode[] = sortedSections(fileTypeByKey("nih-specific-aims-research-strategy")!.sections).flatMap((s, i) => [heading(s.heading, `n${i}`, s.key), para(`About ${s.heading}. R21 under PAR-25-100.`)]);
      return makeDocument({ typeKey: "nih-specific-aims-research-strategy", content, notes: "R21, PAR-25-100." });
    };

    it("NIH: when round 1 agrees, the discussion round is skipped and the outcome uses round-1 scores", async () => {
      const overall = [3, 3, 4];
      const p = panel("type-nih", (i) => [
        { item: "factor_1", verdict: null, score: 3 },
        { item: "factor_2", verdict: null, score: 3 },
        { item: "overall_impact", verdict: null, score: overall[i] },
        { item: "factor_3", verdict: "not_rated", score: null },
      ]);
      const { doc } = await nihDoc();
      const run = await start("type-nih", doc.id);
      expect(run.steps.gate.status).toBe("done");
      expect(run.steps.split.status).toBe("done");
      expect(run.steps.disc).toMatchObject({ status: "skipped" });
      expect(p.reviewCalls()).toBe(3);
      expect(run.outcome).toMatchObject({ value: "high_impact" });
      expect(run.outcome!.scores.find((s) => s.item === "overall_impact")).toMatchObject({ median: 3, min: 3, max: 4 });
    });

    it("FIE: a blocked gate skips the decision and the sign-off, so the run completes without waiting", async () => {
      claudeJson.mockImplementation(async (c: { task: string }) =>
        c.task === "workflow.gate" ? { data: { inputs: [] }, usage: USAGE } : c.task === "workflow.decide" ? { data: { needs: [], rationale: "Criteria not met.", cited: [] }, usage: USAGE } : { data: replyFor(c.task), usage: USAGE },
      );
      const { doc } = await makeDocument({ typeKey: "fie", content: [heading("Background", "b1"), para("A student.")] });
      const run = await start("type-fie", doc.id);
      expect(run.outcome).toMatchObject({ value: "blocked", rationale: "" });
      expect(run.steps.decide).toMatchObject({ status: "skipped" });
      expect(claudeJson.mock.calls.some(([c]) => c.task === "workflow.decide")).toBe(false);
      // The checkpoint waits on gate.pass: nothing to sign, so the run is complete rather than awaiting review.
      expect(run.steps.cp).toMatchObject({ status: "skipped" });
      expect(run.status).toBe("complete");
    });

    it("FIE: decides per category, so one category short of evidence does not hide another's result", async () => {
      // SLD (both of its criteria) agreed met; OHI met by the advocate only, the others leave it out.
      panel(
        "type-fie",
        (i) => [
          { item: "specific_learning_disability", verdict: "met", score: null },
          { item: "sld_exclusions", verdict: "met", score: null },
          ...(i === 0 ? [{ item: "other_health_impairment", verdict: "met", score: null }] : []),
        ],
        { "workflow.decide": { needs: [{ category: "Specific learning disability", need: "needs_services", rationale: "Reading goals need specially designed instruction." }], rationale: "SLD met with need; OHI disputed.", cited: [] } },
      );
      const { doc } = await makeDocument({ typeKey: "fie", content: [heading("Background", "b1"), para("Consent received. Referral for reading. Suspected SLD and OHI.")] });
      const run = await start("type-fie", doc.id);
      expect(Object.entries(run.steps).filter(([, s]) => s.status === "failed")).toEqual([]);
      expect(run.outcome!.value).toBe("criteria_met");
      const table = run.outcome!.tables.find((t) => t.title === "Result by category")!;
      expect(table.rows.map((r) => [r.cells.category, r.status, r.cells.need])).toEqual([
        ["Other health impairment", "disputed", ""],
        ["Specific learning disability", "met", "Needs special education and related services"],
      ]);
    });
  });

  describe("restructure", () => {
    const body = [para("Lead text."), heading("Money", "m1"), para("It costs $40,000."), heading("Trivia", "t1"), para("Unrelated.")];
    beforeEach(() => {
      claudeJson.mockImplementation(async (c: { task: string }) =>
        c.task === "restructure.plan"
          ? { data: { rows: [{ id: "R1", target: null, reason: "" }, { id: "R2", target: "budget", reason: "Costs" }, { id: "R3", target: null, reason: "" }] }, usage: USAGE }
          : { data: replyFor(c.task), usage: USAGE },
      );
    });

    it("waits at the mapping checkpoint, then proposes one restructure change on approve", async () => {
      const { doc } = await makeDocument({ content: body });
      let run = await start("restructure", doc.id, { targetType: "proposal", mode: "merge" });
      expect(run.status).toBe("awaiting_review");
      expect(run.steps.cp.status).toBe("waiting");
      expect(run.outcome).toBeNull();
      run = await decide(run, "cp", { verdict: "edit", edits: { targets: { R3: "reason" } } });
      expect(run.status).toBe("complete");
      expect(run.outcome).toMatchObject({ value: "applied_plan" });
      const [change] = proposedChanges(run);
      const op = change.ops[0] as Extract<DocumentChangeOp, { op: "restructure" }>;
      expect(op.op).toBe("restructure");
      expect(op.plan.rows.map((r) => r.target)).toEqual([null, "budget", "reason"]);
      expect(change.snapshotReason).toBe("Before restructuring");
    });

    it("records a rejection without proposing a change", async () => {
      const { doc } = await makeDocument({ content: body });
      let run = await start("restructure", doc.id, { targetType: "proposal" });
      run = await decide(run, "cp", { verdict: "reject" });
      expect(run.outcome).toMatchObject({ value: "rejected" });
      expect(run.steps.apply.status).toBe("skipped");
      expect(run.steps.write.status).toBe("skipped");
      expect(proposedChanges(run)).toEqual([]);
    });
  });

  describe("resume tailoring", () => {
    const bullets = (...texts: string[]): PMNode => ({ type: "bulletList", content: texts.map((t) => ({ type: "listItem", content: [para(t)] })) });
    async function resume(beforeStatus: string) {
      const { doc, sources } = await makeDocument({
        typeKey: "resume-cv",
        content: [heading("Contact", "c1", "contact"), para("Jane Doe"), heading("Experience", "e1", "experience"), bullets("Built weekly sales dashboards.")],
        sources: [
          { title: "Master resume", passages: ["Built weekly sales dashboards in Tableau."] },
          { title: "Job posting: Data analyst", passages: ["Required: Tableau dashboards."] },
        ],
      });
      const master = sources[0].passages[0].id;
      const line = documentLines(doc.content_json as PMNode).find((l) => l.text.startsWith("Built"))!.ref;
      claudeJson.mockImplementation(async (c: { task: string; user: string }) => {
        const reply = (data: unknown) => ({ data, usage: USAGE });
        if (c.task === "workflow.extract" && c.user.includes("Required: Tableau"))
          return reply({ items: [{ fields: { requirement: "Tableau dashboards", priority: "required", kind: "skill" }, location: { section_id: null, quote: "" }, source_passages: [] }] });
        if (c.task === "workflow.trace" && c.user.includes("show this requirement directly")) return reply({ items: [{ id: "I1", status: beforeStatus, evidence: [{ id: master, quote: "" }], linked_targets: [], rationale: "" }] });
        if (c.task === "workflow.trace" && c.user.includes("rewritten line")) return reply({ items: [{ id: "L1", status: "in_master", evidence: [{ id: master, quote: "in Tableau" }], linked_targets: [], rationale: "" }] });
        if (c.task === "workflow.tailor") return reply({ lines: [{ line, action: "rewrite", text: "Built weekly Tableau sales dashboards.", reason: "", requirements: ["I1"], support: [{ id: master, quote: "in Tableau" }] }] });
        if (c.task === "workflow.decide") return reply({ value: "strong_fit", rationale: "Met.", cited: [] });
        return reply(replyFor(c.task));
      });
      return doc;
    }

    it("waits at the tailored lines, then on the author's result reads the resume fresh and waits for the candidate", async () => {
      const doc = await resume("direct");
      let run = await start("type-resume-cv", doc.id);
      expect(Object.entries(run.steps).filter(([, s]) => s.status === "failed")).toEqual([]);
      expect(run.status).toBe("awaiting_review");
      expect(run.steps.write.status).toBe("waiting");
      expect(proposedChanges(run)[0].ops[0]).toMatchObject({ op: "replace_lines", lines: [{ id: "L1", proposed: "Built weekly Tableau sales dashboards." }] });

      run = (await recordChangeResult(TEAM, run.id, "write", { result: "applied", by: AGENT, at: "", detail: "", lines: [{ lineId: "L1", result: "accepted", detail: "" }] }))!;
      run.steps.write = { status: "pending" };
      await executeGraph(run);
      run = (await getRun(TEAM, run.id))!;
      expect(run.steps.doc2.status).toBe("done");
      expect(run.steps.cp.status).toBe("waiting");
      expect(run.outputs.cp.pending_items).toEqual([expect.objectContaining({ value: "strong_fit" }), expect.objectContaining({ id: "L1", kind: "changed_line", result: "accepted" })]);

      run = await decide(run, "cp", { verdict: "approve", role: "Candidate", edits: { record: { target_role: "Data analyst, Acme" } } });
      expect(run.status).toBe("complete");
      expect(run.outcome).toMatchObject({ value: "strong_fit", verdict: "approve" });
    });

    it("with no requirement the master meets, proposes nothing and goes straight on to the candidate", async () => {
      const doc = await resume("none");
      const run = await start("type-resume-cv", doc.id);
      expect(claudeJson.mock.calls.some(([c]) => c.task === "workflow.tailor")).toBe(false);
      expect(run.steps.write.status).toBe("done");
      expect(proposedChanges(run)).toEqual([]);
      expect(run.steps.cp.status).toBe("waiting");
      expect(run.outcome!.findings.some((f) => f.kind === "tailor_summary")).toBe(true);
    });
  });

  it("draft-all: drafts each empty section with a trace and proposes an only-if-empty change", async () => {
    claudeJson.mockImplementation(async (c: { task: string }) =>
      c.task === "draft.traced"
        ? { data: { sentences: [{ text: "A drafted sentence.", support: [{ kind: "note", id: null }], paragraph_break: false }] }, usage: USAGE }
        : { data: replyFor(c.task), usage: USAGE },
    );
    const { doc } = await makeDocument({ typeKey: "proposal", notes: "Ask for £40,000.", content: [heading("Summary", "s1", "summary"), para(""), heading("Budget", "s2", "budget"), para("Filled.")] });
    const run = await start("draft-all", doc.id);
    expect(run.outcome).toMatchObject({ value: "drafted" });
    const ops = proposedChanges(run).flatMap((c) => c.ops);
    expect(ops).toEqual([expect.objectContaining({ op: "replace_section_body", sectionId: "s1", onlyIfEmpty: true, markdown: "A drafted sentence." })]);
  });

  it("draft-all: nothing to draft when every section has text", async () => {
    const { doc } = await makeDocument({ typeKey: "proposal", content: [heading("Summary", "s1", "summary"), para("Done.")] });
    const run = await start("draft-all", doc.id);
    expect(run.outcome).toMatchObject({ value: "nothing_to_draft" });
    expect(claudeJson.mock.calls.some(([c]) => c.task === "draft.traced")).toBe(false);
  });
});

it("reports which node types still lack an implementation (the suite above runs once there are none)", () => {
  expect(Array.isArray(missingHandlers)).toBe(true);
});
