import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkflowGraph } from "./default-graph";
import { NODE_SPEC_INDEX } from "./registry";
import { runTimeline, stepDuration, toRunSummary } from "./run-stats";
import type { WorkflowRun } from "./store";
import type { GraphEdge, GraphNode, WorkflowGraph } from "./types";

const EXTRACTED = [
  "=== Document: Field notes ===",
  "The river rose two meters in March. Residents moved uphill.",
  "=== Document: Survey summary ===",
  "Most respondents reported damage to crops.",
].join("\n");

const { fetchGroupMetadata } = vi.hoisted(() => ({ fetchGroupMetadata: vi.fn() }));
vi.mock("@/lib/ontology/group-metadata", () => ({ fetchGroupMetadata }));
const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("@/lib/llm/call", () => ({ callModel }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));

const { executeGraph } = await import("./engine");
const { createRun, runResult } = await import("./store");

/** A fake model: plain-text prompts are echoed; categorizer and extractor replies are fixed. */
function fakeModel(opts: { extract?: string } = {}) {
  callModel.mockImplementation(async (c: { system: string; user: string; temperature: number; json?: boolean }) => {
    if (c.json === false) return { text: `ANSWER(${c.user})`, truncated: false };
    if (c.system.startsWith("Choose the ONE category")) return { text: JSON.stringify({ category: "incomplete", justification: "gaps" }), truncated: false };
    return { text: opts.extract ?? JSON.stringify({ key_points: ["a", "b"] }), truncated: false };
  });
}

const auth = { agent: "tester@example.com", permissions: [] };
const runOf = (graph: WorkflowGraph) => createRun("g1", { workflow_id: "default", name: "Default workflow", version: 1, definition: graph, note: "", created_by: "x", created_at: "" }, auth);
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

describe("executeGraph", () => {
  beforeEach(() => {
    callModel.mockReset();
    fetchGroupMetadata.mockReset();
    fetchGroupMetadata.mockResolvedValue({ geminiProcessing: { status: "completed", extractedContent: EXTRACTED } });
  });

  it("runs the default workflow to a saved result", async () => {
    fakeModel();
    const run: WorkflowRun = await runOf(defaultWorkflowGraph());
    await executeGraph(run);
    expect(run.status).toBe("draft");
    expect(Object.values(run.steps).every((s) => s.status === "done")).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(run.outputs.sources.names).toEqual(["Field notes", "Survey summary"]);
    const result = runResult(run)!;
    expect(result).toMatch(/^ANSWER\(Summarize these sources and list gaps/);
    expect(result).toContain("=== Field notes ===\n[D0.P0] The river rose two meters in March.");
    expect(result).toContain("[D1.P0] Most respondents reported damage to crops.");
    // Every step is timed, and the run log and history read it back.
    expect(Object.values(run.steps).every((s) => s.startedAt && s.finishedAt && stepDuration(s) !== null)).toBe(true);
    expect(runTimeline(toRunSummary(run)).at(-1)!.title).toBe("Run finished: result saved");
  });

  it("fails the sources step when the upload has no extracted text, skipping what depends on it", async () => {
    fakeModel();
    fetchGroupMetadata.mockResolvedValue({ geminiProcessing: { status: "processing" } });
    const run = await runOf(defaultWorkflowGraph());
    await executeGraph(run);
    expect(run.steps.sources).toMatchObject({ status: "failed", error: expect.stringMatching(/no extracted text/) });
    expect(run.steps.summarize).toMatchObject({ status: "skipped", note: expect.stringMatching(/failed upstream/) });
    expect(run.status).toBe("failed");
    expect(callModel).not.toHaveBeenCalled();
  });

  it("stops at a human checkpoint and resumes with items left out", async () => {
    fakeModel();
    const g: WorkflowGraph = {
      format: "graph-v1",
      nodes: [node("docs", "source.documents"), node("check", "flow.checkpoint"), node("join", "text.combine", { config: { template: "{{input1}}", inputs: ["input1"] } }), node("output", "output.save")],
      edges: [edge("docs", "documents", "check", "items"), edge("check", "items", "join", "input1"), edge("join", "text", "output", "text")],
    };
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.status).toBe("awaiting_review");
    expect(run.steps.check.status).toBe("waiting");
    expect(run.steps.join.status).toBe("pending");
    expect(run.outputs.check.pending_items).toHaveLength(2);

    // The reviewer leaves out the second document.
    run.checkpoints.check = { excluded: [1], note: "The survey is out of date.", by: "x", at: "" };
    run.steps.check = { status: "pending" };
    run.status = "running";
    await executeGraph(run);
    expect(run.status).toBe("draft");
    expect(run.outputs.check).toMatchObject({ items: [expect.stringContaining("river")], note: "The survey is out of date." });
    expect(runResult(run)).toContain("river");
    expect(runResult(run)).not.toContain("respondents");
  });

  it("skips the branch not taken", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.nodes.push(node("if", "logic.if", { config: { operator: "contains", value: "river" } }), node("yes", "ai.ask"), node("no", "ai.ask"));
    g.edges.push(
      edge("sources", "combined", "if", "value"),
      edge("if", "true", "yes", "input"),
      edge("if", "false", "no", "input"),
      edge("yes", "response", "output", "text"),
      edge("no", "response", "output", "text"),
    );
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.steps.yes.status).toBe("done");
    expect(run.steps.no).toMatchObject({ status: "skipped", note: expect.stringMatching(/branch not taken/) });
    expect(run.status).toBe("draft");
    // The summary and the branch taken, joined.
    expect(runResult(run)!.split("\n\nANSWER(")).toHaveLength(2);
  });

  it("loops a node over a list, one call per item", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.nodes.push(node("sum", "ai.ask", { loop: true, config: { ...NODE_SPEC_INDEX["ai.ask"].defaults(), prompt: "Summarize: {{input}}" } }));
    g.edges.push(edge("sources", "documents", "sum", "input"), edge("sum", "response", "output", "text"));
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.outputs.sum.response).toHaveLength(2);
    expect((run.outputs.sum.response as string[])[1]).toMatch(/^ANSWER\(Summarize: \[D1\.P0\] Most respondents/);
    expect(run.status).toBe("draft");
  });

  it("filters source documents by name", async () => {
    fakeModel();
    const g = defaultWorkflowGraph();
    g.nodes[0] = { ...g.nodes[0], config: { nameContains: "survey" } };
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.outputs.sources.names).toEqual(["Survey summary"]);
    expect(run.outputs.sources.combined).toBe("=== Survey summary ===\n[D0.P0] Most respondents reported damage to crops.");
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
      edge("sources", "combined", "ext", "text"),
      edge("summarize", "response", "cat", "text"),
      edge("ext", "key_points", "route", "value"),
      edge("cat", "category", "route", "key"),
      edge("route", "incomplete", "more", "input1"),
      edge("more", "text", "output", "text"),
    );
    const run = await runOf(g);
    await executeGraph(run);
    expect(run.outputs.ext.key_points).toEqual(["a", "b"]);
    expect(run.outputs.cat.category).toBe("Incomplete");
    expect(run.outputs.route).toEqual({ incomplete: ["a", "b"] });
    expect(run.outputs.more.text).toBe("Needs more: - a\n- b");
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
});
