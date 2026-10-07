import { describe, expect, it, vi } from "vitest";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";

// Without POSTGRES_URL the store keeps workflows in memory, which is what these exercise.
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));
const svc = await import("./store");

const auth = { agent: "a@example.com", permissions: [] };
const graph = defaultWorkflowGraph();
const edited = { ...graph, nodes: graph.nodes.map((n) => (n.id === "sources" ? { ...n, label: "Sources (edited)" } : n)) };

describe("named workflows", () => {
  it("starts with the original workflow on its built-in default, as the default", async () => {
    const list = await svc.listWorkflows();
    expect(list.map((w) => w.id)).toContain(svc.LEGACY_WORKFLOW_ID);
    expect(await svc.getDefaultWorkflowId()).toBe(svc.LEGACY_WORKFLOW_ID);
    expect((await svc.getWorkflow(svc.LEGACY_WORKFLOW_ID))?.version).toBe(0);
  });

  it("numbers each workflow's versions on their own, and can open an earlier one", async () => {
    const w = await svc.createWorkflow("Literature review", graph, auth);
    expect(w.latestVersion).toBe(1);
    await svc.saveWorkflow(w.id, edited, "renamed sources", auth);
    // Another workflow's saves don't touch this one's numbering.
    await svc.saveWorkflow(svc.LEGACY_WORKFLOW_ID, graph, "", auth);
    expect((await svc.listVersions(w.id)).map((v) => v.version)).toEqual([2, 1]);
    expect((await svc.getWorkflow(w.id))?.definition.nodes[0].label).toBe("Sources (edited)");
    expect((await svc.getWorkflow(w.id, 1))?.definition.nodes[0].label).not.toBe("Sources (edited)");
    expect(await svc.getWorkflow(w.id, 9)).toBeNull();
  });

  it("records which workflow and version a run used", async () => {
    const w = await svc.createWorkflow("Second", graph, auth);
    const run = await svc.createRun("group-1", (await svc.getWorkflow(w.id, 1))!, auth);
    expect(run).toMatchObject({ workflow_id: w.id, workflow_name: "Second", workflow_version: 1 });
  });

  it("changes the default, and renames", async () => {
    const w = await svc.createWorkflow("Third", graph, auth);
    expect(await svc.setDefaultWorkflowId(w.id, auth)).toBe(true);
    expect(await svc.getDefaultWorkflowId()).toBe(w.id);
    expect((await svc.activeWorkflow()).workflow_id).toBe(w.id);
    expect(await svc.setDefaultWorkflowId("missing", auth)).toBe(false);
    expect(await svc.renameWorkflow(w.id, "Third, renamed", auth)).toBe(true);
    expect((await svc.listWorkflows()).find((x) => x.id === w.id)?.name).toBe("Third, renamed");
  });
});
