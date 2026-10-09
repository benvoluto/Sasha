import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { resetSourceStore } from "@/lib/sources/store";
import { resetDataStore } from "@/lib/data/store";
import { OUTCOME_BLOCKED, OUTCOME_BLOCKED_LABEL, type Finding, type WorkflowRunRecord } from "./contract";
import { defaultWorkflowGraph } from "./default-graph";
import { NODE_SPEC_INDEX } from "./registry";
import { runTimeline, stepDuration, toRunSummary } from "./run-stats";
import type { SavedWorkflow } from "./store";
import type { GraphEdge, GraphNode, WorkflowGraph } from "./types";

const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("@/lib/llm/call", () => ({ callModel }));
const { audit } = vi.hoisted(() => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: audit }) }));

// Small fake step handlers, so the engine is tested on its own (the real ones live in ./nodes and ./generic).
const fake = vi.hoisted(() => ({
  gateMissing: [] as string[],
  checkFindings: [] as unknown[],
  checkFails: false,
  /** draft.section: advance the clock this much per item, and wait this long (real time). */
  draftAdvanceMs: 0,
  draftDelayMs: 0,
  draftActive: 0,
  draftMaxActive: 0,
  drafted: [] as string[],
}));
const finding = (id: string, severity: Finding["severity"], kind = "gap"): Finding => ({
  id,
  nodeId: id.split(":")[0],
  kind,
  severity,
  status: null,
  title: `Finding ${id}`,
  detail: "",
  location: null,
  evidence: [],
  reviewer: null,
  verified: true,
  fix: "",
});
vi.mock("./nodes", () => ({
  STEP_HANDLERS: {
    "sources.read": async (_i: unknown, r: { config: Record<string, unknown> }, ctx: { document(): Promise<{ title: string }> }) => {
      const doc = await ctx.document();
      const passages = [
        { id: "S1a2b3c4d.P0", sourceId: "s1", page: 1, text: "The river rose two meters in March." },
        { id: "S5e6f7a8b.P0", sourceId: "s2", page: null, text: "Most respondents reported damage to crops." },
      ].filter((p) => !r.config.nameContains || p.sourceId === r.config.nameContains);
      return { sources: { sources: [], passages }, passages, text: `${doc.title}\n${passages.map((p) => `[${p.id}] ${p.text}`).join("\n")}` };
    },
    "doc.read": async (_i: unknown, _r: unknown, ctx: { document(): Promise<{ id: string; title: string }> }) => {
      const doc = await ctx.document();
      return { document: { id: doc.id, title: doc.title }, text: "", sections: [], empty_sections: ["a", "b", "c", "d", "e"], type: null };
    },
    "step.gate": async () => {
      const missing = fake.gateMissing.map((label) => ({ key: label.toLowerCase(), label, required: true, present: false, how: "none", evidence: [], help: "" }));
      const report = { items: missing, missing };
      return missing.length ? { blocked: report, report } : { pass: report, report };
    },
    "step.check": async () => {
      if (fake.checkFails) throw new Error("the model is unavailable");
      return { results: [], findings: fake.checkFindings, table: { key: "checks", title: "Checks", columns: [{ key: "c", label: "C" }], rows: [] } };
    },
    "doc.write": async (inputs: { ops?: unknown[] }, r: { node: { id: string } }) => ({
      change: { id: r.node.id, title: "Change", summary: "", ops: inputs.ops ?? [], basisUpdatedAt: "", snapshotReason: "Before" },
    }),
  },
}));
vi.mock("./generic", () => ({
  GENERIC_HANDLERS: {
    "draft.section": async (inputs: { section: string }) => {
      fake.drafted.push(inputs.section);
      fake.draftActive++;
      fake.draftMaxActive = Math.max(fake.draftMaxActive, fake.draftActive);
      if (fake.draftAdvanceMs) vi.setSystemTime(Date.now() + fake.draftAdvanceMs);
      await new Promise((r) => setTimeout(r, fake.draftDelayMs));
      fake.draftActive--;
      return { draft: { section: inputs.section }, op: { op: "replace_section_body", sectionId: inputs.section }, findings: [{ ...finding("draft:1", "info"), title: inputs.section }] };
    },
  },
}));

const { executeGraph, HANDLERS, LOOP_CONCURRENCY, progressItem } = await import("./engine");
const { createRun, getRun, normalizeRun, resetWorkflowStore } = await import("./store");
const { checkpointDecisionFor } = await import("./core-nodes");

const TEAM = "org:a";
const auth = { agent: "tester@example.com", permissions: [] };

/** A fake model: plain-text prompts are echoed; categorizer and extractor replies are fixed. */
function fakeModel() {
  callModel.mockImplementation(async (c: { system: string; user: string; json?: boolean }) => {
    if (c.json === false) return { text: `ANSWER(${c.user})`, truncated: false };
    if (c.system.startsWith("Choose the ONE category")) return { text: JSON.stringify({ category: "incomplete", justification: "gaps" }), truncated: false };
    return { text: JSON.stringify({ key_points: ["a", "b"] }), truncated: false };
  });
}

const saved = (graph: WorkflowGraph): SavedWorkflow => ({ workflow_id: "wf-1", name: "Test workflow", version: 1, graph, note: "", created_by: "x", created_at: "", readOnly: false, based_on: null });
async function runOf(graph: WorkflowGraph): Promise<WorkflowRunRecord> {
  const doc = await createDocument(TEAM, "ann", { title: "Flood report" });
  return createRun(TEAM, doc.id, saved(graph), {}, auth);
}
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  config: NODE_SPEC_INDEX[type].defaults(),
  loop: false,
  expanded: false,
  ...extra,
});
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): GraphEdge => ({ id: `${source}.${sourceHandle}-${target}.${targetHandle}`, source, sourceHandle, target, targetHandle });
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): WorkflowGraph => ({ format: "graph-v1", nodes, edges });

/** Gate → checklist (after the gate passes) → outcome. */
const gatedGraph = () =>
  graphOf(
    [node("gate", "step.gate"), node("check", "step.check"), node("outcome", "outcome.report")],
    [edge("gate", "pass", "check", "after"), edge("gate", "blocked", "outcome", "blocked"), edge("check", "findings", "outcome", "findings")],
  );

/** Checklist → outcome → a signing checkpoint → a write only once approved. */
function signedGraph() {
  const cp = node("cp", "checkpoint", {
    config: { ...NODE_SPEC_INDEX.checkpoint.defaults(), role: "Supervisor", signsOutcome: true, editable: "outcome", recordFields: [{ key: "signed_name", label: "Name and credential", required: true }] },
  });
  return graphOf(
    [node("check", "step.check"), node("outcome", "outcome.report"), cp, node("write", "doc.write")],
    [edge("check", "findings", "outcome", "findings"), edge("outcome", "outcome", "cp", "items"), edge("cp", "approved", "write", "after")],
  );
}

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  resetSourceStore();
  resetDataStore();
  resetWorkflowStore();
  callModel.mockReset();
  audit.mockClear();
  Object.assign(fake, { gateMissing: [], checkFindings: [], checkFails: false, draftAdvanceMs: 0, draftDelayMs: 0, draftActive: 0, draftMaxActive: 0, drafted: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("executeGraph", () => {
  it("merges the step, generic and core handlers", () => {
    expect(Object.keys(HANDLERS)).toEqual(expect.arrayContaining(["sources.read", "draft.section", "checkpoint", "outcome.report", "ai.ask", "logic.router"]));
  });

  it("runs the default workflow to a complete run with an outcome", async () => {
    fakeModel();
    const run = await runOf(defaultWorkflowGraph());
    await executeGraph(run);
    expect(run.status).toBe("complete");
    expect(Object.values(run.steps).every((s) => s.status === "done")).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(run.outcome).toMatchObject({ value: "sound", valueLabel: "Sound", advisory: true, workflowKey: "wf-1", missing: [], incomplete: [] });
    expect(run.outcome!.values.at(-1)).toEqual({ key: OUTCOME_BLOCKED, label: OUTCOME_BLOCKED_LABEL });
    // The summary prompt saw the document-scoped passages, and its answer is the rationale.
    expect(run.outcome!.rationale).toMatch(/^ANSWER\(Summarize these sources and list gaps/);
    expect(run.outcome!.rationale).toContain("Flood report\n[S1a2b3c4d.P0] The river rose two meters in March.");
    // Every step is timed, the run log reads it back, and the stored copy matches.
    expect(Object.values(run.steps).every((s) => s.startedAt && s.finishedAt && stepDuration(s) !== null)).toBe(true);
    expect(runTimeline(toRunSummary(run)).at(-1)!.title).toBe("Run finished: outcome recorded");
    expect((await getRun(TEAM, run.id))?.outcome?.value).toBe("sound");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow_run_complete", args: { documentId: run.document_id, runId: run.id }, result: { documentId: run.document_id, runId: run.id, value: "sound" } }));
  });

  it("fails a step whose document was deleted, and reports the outcome as incomplete", async () => {
    fakeModel();
    const run = await runOf(defaultWorkflowGraph());
    resetMemoryStore();
    await executeGraph(run);
    expect(run.steps.sources).toMatchObject({ status: "failed", error: "the document was deleted" });
    expect(run.steps.summarize).toMatchObject({ status: "skipped", note: expect.stringMatching(/failed upstream/) });
    expect(run.outcome).toMatchObject({ value: null, valueLabel: "No outcome", incomplete: ["Source passages"] });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("blocks on a gate's missing inputs and skips what runs after it", async () => {
    fake.gateMissing = ["Written consent"];
    fake.checkFindings = [finding("check:1", "major")];
    const run = await runOf(gatedGraph());
    await executeGraph(run);
    expect(run.steps.check).toMatchObject({ status: "skipped", note: "not reached: Gate" });
    expect(run.status).toBe("complete");
    expect(run.outcome).toMatchObject({ value: OUTCOME_BLOCKED, valueLabel: OUTCOME_BLOCKED_LABEL, missing: ["Written consent"], findings: [] });
  });

  it("runs the steps after a gate that passes, without handing them the gate's value", async () => {
    const seen = vi.fn();
    const real = HANDLERS["step.check"];
    HANDLERS["step.check"] = async (inputs, r, ctx) => {
      seen(Object.keys(inputs));
      return real(inputs, r, ctx);
    };
    try {
      fake.checkFindings = [finding("check:1", "major")];
      const run = await runOf(gatedGraph());
      await executeGraph(run);
      expect(run.steps.check.status).toBe("done");
      expect(seen).toHaveBeenCalledWith([]);
      expect(run.outcome).toMatchObject({ value: "gaps_found", missing: [] });
    } finally {
      HANDLERS["step.check"] = real;
    }
  });

  it("gives an incomplete outcome (no value) when a step fails", async () => {
    fake.checkFails = true;
    const run = await runOf(gatedGraph());
    await executeGraph(run);
    expect(run.steps.check).toMatchObject({ status: "failed", error: "the model is unavailable" });
    expect(run.outcome).toMatchObject({ value: null, incomplete: ["Checklist"] });
    expect(run.status).toBe("complete");
  });

  describe("signing checkpoint", () => {
    async function decide(run: WorkflowRunRecord, cp: Parameters<typeof checkpointDecisionFor>[1]) {
      const checked = await checkpointDecisionFor(run, cp, "sup@example.com");
      if (!checked.ok) throw new Error(checked.error);
      run.checkpoints.cp = checked.decision;
      run.steps.cp = { status: "pending" };
      run.status = "running";
      await executeGraph(run);
    }

    async function waiting() {
      fake.checkFindings = [finding("check:1", "minor")];
      const run = await runOf(signedGraph());
      await executeGraph(run);
      expect(run.status).toBe("awaiting_review");
      expect(run.steps.cp.status).toBe("waiting");
      expect(run.steps.write.status).toBe("pending");
      expect(run.outputs.cp.pending_items).toEqual([run.outcome]);
      expect(run.outcome).toMatchObject({ value: "sound", advisory: true, verdict: null });
      return run;
    }

    it("waits, then approval signs the outcome and lets approved steps run", async () => {
      const run = await waiting();
      await decide(run, { nodeId: "cp", verdict: "approve", note: "", excluded: [], edits: { record: { signed_name: "Dr. Sue, LSSP" } } });
      expect(run.status).toBe("complete");
      expect(run.outcome).toMatchObject({ value: "sound", advisory: false, verdict: "approve", signedBy: "sup@example.com", signedRole: "Supervisor", record: { signed_name: "Dr. Sue, LSSP" }, originalValue: null });
      expect(run.outcome!.signedAt).toBeTruthy();
      expect(run.outputs.outcome.outcome).toEqual(run.outcome);
      expect(run.outputs.cp).toMatchObject({ decision: { verdict: "approve" }, approved: [expect.objectContaining({ value: "sound" })] });
      expect(run.steps.write.status).toBe("done");
    });

    it("an edit changes the value and keeps the original", async () => {
      const run = await waiting();
      await decide(run, { nodeId: "cp", verdict: "edit", note: "Two gaps", excluded: [], edits: { outcomeValue: "gaps_found", record: { signed_name: "Dr. Sue" } } });
      expect(run.outcome).toMatchObject({ value: "gaps_found", valueLabel: "Gaps found", originalValue: "sound", advisory: false, verdict: "edit" });
    });

    it("a rejection stays advisory, sets rejected and skips the approved branch", async () => {
      const run = await waiting();
      await decide(run, { nodeId: "cp", verdict: "reject", note: "Redo", excluded: [] });
      expect(run.status).toBe("complete");
      expect(run.outcome).toMatchObject({ advisory: true, verdict: "reject", signedBy: "sup@example.com", signedRole: null });
      expect(run.outputs.cp.rejected).toHaveLength(1);
      expect(run.outputs.cp.approved).toBeUndefined();
      expect(run.steps.write).toMatchObject({ status: "skipped", note: "not reached: Human checkpoint" });
    });

    it("refuses decisions the checkpoint doesn't allow", async () => {
      const run = await waiting();
      const check = (cp: Parameters<typeof checkpointDecisionFor>[1]) => checkpointDecisionFor(run, cp, "x");
      expect(await check({ nodeId: "cp", verdict: "approve", note: "", excluded: [] })).toEqual({ ok: false, error: "Fill in “Name and credential”." });
      expect(await check({ nodeId: "cp", verdict: "edit", note: "", excluded: [], edits: { outcomeValue: "great", record: { signed_name: "S" } } })).toMatchObject({ ok: false });
      expect(await check({ nodeId: "cp", verdict: "approve", note: "", excluded: [], edits: { outcomeValue: "gaps_found", record: { signed_name: "S" } } })).toMatchObject({ ok: false });
      expect(await check({ nodeId: "cp", verdict: "edit", note: "", excluded: [], edits: { targets: { R1: null }, record: { signed_name: "S" } } })).toMatchObject({ ok: false });
      expect(await check({ nodeId: "write", verdict: "approve", note: "", excluded: [] })).toMatchObject({ ok: false });
    });
  });

  it("pauses a resumable loop when an item would outlast the deadline, then runs only the unfinished items", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    fake.draftAdvanceMs = 60_000;
    const graph = graphOf(
      [node("doc", "doc.read"), node("draft", "draft.section", { loop: true }), node("outcome", "outcome.report")],
      [edge("doc", "empty_sections", "draft", "section"), edge("doc", "document", "draft", "document"), edge("draft", "findings", "outcome", "findings")],
    );
    const run = await runOf(graph);
    // The invocation has 275 s; draft.section needs 150 s left to start an item, two at a time.
    await executeGraph(run);
    expect(run.status).toBe("paused");
    expect(run.pause_reason).toBe("budget");
    expect(fake.drafted).toEqual(["a", "b", "c"]);
    expect(run.steps.draft).toMatchObject({ status: "pending", progress: { done: 3, total: 5 } });
    // Each item's state is listed on the step: the finished ones done, the rest still pending.
    expect(run.steps.draft.progress!.items!.map((i) => i.state)).toEqual(["done", "done", "done", "pending", "pending"]);
    expect((run.outputs.draft.__loop as { results: unknown[] }).results.filter(Boolean)).toHaveLength(3);
    expect(run.steps.outcome.status).toBe("pending");
    expect((await getRun(TEAM, run.id))?.status).toBe("paused");

    run.status = "running";
    await executeGraph(run);
    expect(fake.drafted).toEqual(["a", "b", "c", "d", "e"]);
    expect(run.status).toBe("complete");
    expect(run.steps.draft).toMatchObject({ status: "done", progress: { done: 5, total: 5 } });
    expect(run.steps.draft.progress!.items!.every((i) => i.state === "done")).toBe(true);
    expect(run.outputs.draft.__loop).toBeUndefined();
    expect((run.outputs.draft.op as unknown[]).length).toBe(5);
    // A loop's findings are a list of lists; the outcome sees them flattened.
    // Each item numbers its findings from 1, so the engine renumbers them per
    // item; otherwise the outcome's dedupe by id would keep only the first.
    expect(run.outcome!.findings.map((f) => f.id)).toEqual(["draft:1.1", "draft:2.1", "draft:3.1", "draft:4.1", "draft:5.1"]);
    expect(run.outcome!.findings.map((f) => f.title)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("runs a loop's items at most maxConcurrency at a time", async () => {
    fake.draftDelayMs = 5;
    const graph = graphOf(
      [node("doc", "doc.read"), node("draft", "draft.section", { loop: true }), node("outcome", "outcome.report")],
      [edge("doc", "empty_sections", "draft", "section"), edge("draft", "findings", "outcome", "findings")],
    );
    const run = await runOf(graph);
    await executeGraph(run);
    expect(run.status).toBe("complete");
    expect(fake.drafted).toHaveLength(5);
    expect(NODE_SPEC_INDEX["draft.section"].maxConcurrency).toBe(2);
    expect(fake.draftMaxActive).toBe(2);
  });

  it("runs a model loop with no maxConcurrency at most LOOP_CONCURRENCY at a time", async () => {
    let active = 0;
    let maxActive = 0;
    callModel.mockImplementation(async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { text: "ok", truncated: false };
    });
    const graph = graphOf(
      [node("doc", "doc.read"), node("ask", "ai.ask", { loop: true }), node("outcome", "outcome.report")],
      [edge("doc", "empty_sections", "ask", "input"), edge("ask", "response", "outcome", "summary")],
    );
    const run = await runOf(graph);
    await executeGraph(run);
    expect(run.steps.ask.status).toBe("done");
    expect(run.outputs.ask.response).toHaveLength(5);
    expect(NODE_SPEC_INDEX["ai.ask"].maxConcurrency).toBeUndefined();
    expect(LOOP_CONCURRENCY).toBeLessThan(5);
    expect(maxActive).toBe(LOOP_CONCURRENCY);
  });

  it("pauses before starting a node that needs more time than the deadline leaves", async () => {
    const graph = graphOf(
      [node("doc", "doc.read"), node("draft", "draft.section", { loop: true }), node("outcome", "outcome.report")],
      [edge("doc", "empty_sections", "draft", "section"), edge("draft", "findings", "outcome", "findings")],
    );
    const run = await runOf(graph);
    await executeGraph(run, { deadline: Date.now() + 60_000 });
    expect(run.steps.doc.status).toBe("done");
    expect(run.steps.draft.status).toBe("pending");
    expect(fake.drafted).toEqual([]);
    expect(run).toMatchObject({ status: "paused", pause_reason: "budget" });
  });

  it("runs a legacy graph (source.documents, flow.checkpoint, output.save) after normalizing it", async () => {
    fakeModel();
    const doc = await createDocument(TEAM, "ann", { title: "Old" });
    const legacy = normalizeRun({
      id: "r-old",
      team_id: TEAM,
      document_id: doc.id,
      status: "draft",
      workflow_id: "default",
      workflow_name: "Default workflow",
      workflow_version: "2",
      workflow: graphOf(
        [
          { ...node("docs", "ai.ask"), type: "source.documents", config: { nameContains: "" } },
          { ...node("check", "ai.ask"), type: "flow.checkpoint", config: { instructions: "Look", allowExclude: true } },
          node("ask", "ai.ask"),
          { ...node("output", "ai.ask"), type: "output.save", config: {} },
        ],
        [edge("docs", "combined", "check", "items"), edge("check", "items", "ask", "input"), edge("ask", "response", "output", "text")],
      ),
      steps: {},
      checkpoints: { check: { excluded: [], note: "ok", by: "a@example.com", at: "2026-01-01T00:00:00.000Z" } },
      requested_by: "a@example.com",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    })!;
    expect(legacy.status).toBe("complete");
    expect(legacy.workflow_version).toBe(2);
    expect(legacy.graph.nodes.map((n) => n.type)).toEqual(["sources.read", "checkpoint", "ai.ask", "outcome.report"]);
    expect(legacy.graph.nodes[1].config).toMatchObject({ instructions: "Look", allowExclude: true, role: "Reviewer", editable: "none" });
    expect(legacy.graph.edges.map((e) => `${e.sourceHandle}->${e.targetHandle}`)).toEqual(["text->items", "items->input", "response->summary"]);
    expect(legacy.checkpoints.check).toMatchObject({ verdict: "approve", note: "ok", role: "", edits: null });

    // It still runs: the old decision approves the checkpoint.
    legacy.status = "running";
    legacy.steps = {};
    await executeGraph(legacy);
    expect(legacy.status).toBe("complete");
    expect(legacy.outcome?.rationale).toMatch(/^ANSWER\(/);
  });

  it("refuses an invalid workflow without calling any model", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.edges = g.edges.filter((e) => e.target !== "summarize");
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.status).toBe("failed");
    expect(callModel).not.toHaveBeenCalled();
  });

  it("skips the branch not taken", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.nodes.push(node("if", "logic.if", { config: { operator: "contains", value: "river" } }), node("yes", "ai.ask"), node("no", "ai.ask"));
    g.edges.push(
      edge("sources", "text", "if", "value"),
      edge("if", "true", "yes", "input"),
      edge("if", "false", "no", "input"),
      edge("yes", "response", "outcome", "summary"),
      edge("no", "response", "outcome", "summary"),
    );
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.steps.yes.status).toBe("done");
    expect(run.steps.no).toMatchObject({ status: "skipped", note: expect.stringMatching(/branch not taken/) });
    expect(run.status).toBe("complete");
    // The summary and the branch taken, joined.
    expect(run.outcome!.rationale.split("\n\nANSWER(")).toHaveLength(2);
  });

  it("labels loop items for the progress list from their heading and section", () => {
    expect(progressItem({ heading: "Budget", sectionId: "b1", markdown: "…" }, 0)).toEqual({ label: "Budget", sectionId: "b1" });
    expect(progressItem({ title: "  A source " }, 1)).toEqual({ label: "A source" });
    expect(progressItem("a", 2)).toEqual({ label: "Item 3" });
    expect(progressItem({ heading: "x".repeat(200) }, 0).label).toHaveLength(120);
  });

  it("loops a core node over a list, one call per item", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.nodes.push(node("sum", "ai.ask", { loop: true, config: { ...NODE_SPEC_INDEX["ai.ask"].defaults(), prompt: "Summarize: {{input}}" } }));
    g.edges.push(edge("sources", "passages", "sum", "input"), edge("sum", "response", "outcome", "summary"));
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.outputs.sum.response).toHaveLength(2);
    expect((run.outputs.sum.response as string[])[1]).toMatch(/^ANSWER\(Summarize: [\s\S]*Most respondents/);
    expect(run.steps.sum.progress).toEqual({ done: 2, total: 2, items: [{ label: "Item 1", state: "done" }, { label: "Item 2", state: "done" }] });
    expect(run.status).toBe("complete");
  });

  it("extracts fields and routes on a categorizer's answer", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.nodes.push(
      node("ext", "ai.extract"),
      node("cat", "ai.categorize"),
      node("route", "logic.router"),
      node("more", "text.combine", { config: { template: "Needs more: {{input1}}", inputs: ["input1"] } }),
    );
    g.edges.push(
      edge("sources", "text", "ext", "text"),
      edge("summarize", "response", "cat", "text"),
      edge("ext", "key_points", "route", "value"),
      edge("cat", "category", "route", "key"),
      edge("route", "incomplete", "more", "input1"),
      edge("more", "text", "outcome", "summary"),
    );
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.outputs.ext.key_points).toEqual(["a", "b"]);
    expect(run.outputs.cat.category).toBe("Incomplete");
    expect(run.steps.cat.note).toBe("Incomplete");
    expect(run.outputs.route).toEqual({ incomplete: ["a", "b"] });
    expect(run.outputs.more.text).toBe("Needs more: - a\n- b");
  });

  it("stops quietly when a later start supersedes the run", async () => {
    fakeModel();
    const doc = await createDocument(TEAM, "ann", { title: "D" });
    const first = await createRun(TEAM, doc.id, saved(defaultWorkflowGraph()), {}, auth);
    await createRun(TEAM, doc.id, saved(defaultWorkflowGraph()), {}, auth);
    await executeGraph(first);
    expect(first.status).toBe("superseded");
    expect((await getRun(TEAM, first.id))?.status).toBe("superseded");
  });
});
