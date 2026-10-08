import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";

// Without POSTGRES_URL the store keeps workflows in memory, which is what these exercise.
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));
// One small built-in, so the tests don't depend on the shipped catalog.
vi.mock("@/catalog/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/catalog/workflows")>();
  const def = {
    key: "mini-review",
    version: 3,
    title: "Mini review",
    summary: "A small built-in for tests.",
    kind: "generic",
    appliesTo: [],
    fallback: false,
    outcome: { label: "Result", values: [{ key: "ok", label: "OK" }, { key: "gaps", label: "Gaps" }] },
    checkpoint: null,
    params: [],
    requirementSets: [],
    notAssessed: [],
    notes: [],
    provenance: { source: "test", checked: "2026-10-08" },
    steps: [
      { id: "src", node: "sources.read", config: {}, in: {}, loop: false },
      { id: "out", node: "outcome.report", config: { rules: [], fallback: "ok" }, in: { summary: "src.text" }, loop: false },
    ],
  };
  return { ...actual, builtInWorkflows: () => [def], builtInWorkflow: (key: string) => (key === def.key ? def : null) };
});

const svc = await import("./store");

const auth = { agent: "a@example.com", permissions: [] };
const graph = defaultWorkflowGraph();
const edited = { ...graph, nodes: graph.nodes.map((n) => (n.id === "sources" ? { ...n, label: "Sources (edited)" } : n)) };

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  svc.resetWorkflowStore();
});

describe("team workflows", () => {
  it("numbers each workflow's versions on their own, and can open an earlier one", async () => {
    const w = await svc.createWorkflow("org:a", "Literature review", graph, auth);
    expect(w).toMatchObject({ latestVersion: 1, builtIn: false, based_on: null });
    await svc.saveWorkflow("org:a", w.id, edited, "renamed sources", auth);
    const other = await svc.createWorkflow("org:a", "Other", graph, auth);
    await svc.saveWorkflow("org:a", other.id, graph, "", auth);
    expect((await svc.listVersions("org:a", w.id)).map((v) => v.version)).toEqual([2, 1]);
    expect((await svc.getWorkflow("org:a", w.id))?.graph.nodes[0].label).toBe("Sources (edited)");
    expect((await svc.getWorkflow("org:a", w.id, 1))?.graph.nodes[0].label).not.toBe("Sources (edited)");
    expect(await svc.getWorkflow("org:a", w.id, 9)).toBeNull();
    expect((await svc.getWorkflow("org:a", w.id, 0))?.version).toBe(0);
  });

  it("keeps each team's workflows to itself", async () => {
    const w = await svc.createWorkflow("org:a", "Ours", graph, auth);
    expect(await svc.listWorkflows("org:b")).toEqual([]);
    expect(await svc.getWorkflow("org:b", w.id)).toBeNull();
    expect(await svc.listVersions("org:b", w.id)).toEqual([]);
    expect(await svc.renameWorkflow("org:b", w.id, "Theirs", auth)).toBe(false);
    await expect(svc.saveWorkflow("org:b", w.id, graph, "", auth)).rejects.toThrow(/not found/);
    expect(await svc.renameWorkflow("org:a", w.id, "Ours, renamed", auth)).toBe(true);
    expect((await svc.listWorkflows("org:a"))[0].name).toBe("Ours, renamed");
  });
});

describe("built-in workflows", () => {
  it("resolve as builtin:<key>, compiled from the definition, read-only, with no saved versions", async () => {
    const b = await svc.getWorkflow("org:a", "builtin:mini-review");
    expect(b).toMatchObject({ workflow_id: "builtin:mini-review", name: "Mini review", version: 3, readOnly: true });
    expect(b!.graph.nodes.map((n) => n.type)).toEqual(["sources.read", "outcome.report"]);
    expect(b!.graph.nodes[1].config).toMatchObject({ label: "Result", values: [{ key: "ok", label: "OK" }, { key: "gaps", label: "Gaps" }] });
    expect(await svc.getWorkflow("org:a", "builtin:mini-review", 3)).not.toBeNull();
    expect(await svc.getWorkflow("org:a", "builtin:mini-review", 2)).toBeNull();
    expect(await svc.getWorkflow("org:a", "builtin:nope")).toBeNull();
    expect(await svc.listVersions("org:a", "builtin:mini-review")).toEqual([]);
    expect(svc.builtInList()).toEqual([{ id: "builtin:mini-review", title: "Mini review" }]);
    expect((await svc.listWorkflows("org:a", { includeBuiltIns: true })).map((w) => [w.id, w.builtIn])).toEqual([["builtin:mini-review", true]]);
  });

  it("refuses saving or renaming a built-in, and copies one into a team workflow", async () => {
    await expect(svc.saveWorkflow("org:a", "builtin:mini-review", graph, "", auth)).rejects.toBeInstanceOf(svc.ReadOnlyWorkflowError);
    expect(await svc.renameWorkflow("org:a", "builtin:mini-review", "Mine", auth)).toBe(false);
    const source = (await svc.getWorkflow("org:a", "builtin:mini-review"))!;
    const copy = await svc.createWorkflow("org:a", "My review", source.graph, auth, source.workflow_id);
    expect(copy.based_on).toBe("builtin:mini-review");
    expect((await svc.getWorkflow("org:a", copy.id))).toMatchObject({ readOnly: false, based_on: "builtin:mini-review", version: 1 });
  });
});

describe("the canvas default (app_setting per team)", () => {
  it("falls back to the team's oldest workflow, then the first built-in", async () => {
    expect(await svc.getDefaultWorkflowId("org:a")).toBe("builtin:mini-review");
    const w = await svc.createWorkflow("org:a", "First", graph, auth);
    expect(await svc.getDefaultWorkflowId("org:a")).toBe(w.id);
    expect(await svc.getDefaultWorkflowId("org:b")).toBe("builtin:mini-review");
  });

  it("is set per team, to a workflow the team can see", async () => {
    const a = await svc.createWorkflow("org:a", "A", graph, auth);
    const second = await svc.createWorkflow("org:a", "A2", graph, auth);
    expect(await svc.setDefaultWorkflowId("org:a", second.id, auth)).toBe(true);
    expect(await svc.getDefaultWorkflowId("org:a")).toBe(second.id);
    expect(await svc.setDefaultWorkflowId("org:b", a.id, auth)).toBe(false);
    expect(await svc.setDefaultWorkflowId("org:b", "builtin:mini-review", auth)).toBe(true);
    expect(await svc.getDefaultWorkflowId("org:b")).toBe("builtin:mini-review");
    expect(await svc.getDefaultWorkflowId("org:a")).toBe(second.id);
    expect(await svc.setDefaultWorkflowId("org:a", "missing", auth)).toBe(false);
  });
});
