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

describe("workflows bound to a type (Phase 8)", () => {
  it("records the bound type, keeps the old positional basedOn, and deletes a team workflow with its versions", async () => {
    const bound = await svc.createWorkflow("org:a", "Learned review", graph, auth, { appliesTo: "equipment-request", note: "Learned from 2 examples" });
    expect(bound).toMatchObject({ applies_to: "equipment-request", based_on: null });
    expect((await svc.getWorkflow("org:a", bound.id))?.note).toBe("Learned from 2 examples");
    const copy = await svc.createWorkflow("org:a", "Copy", graph, auth, "builtin:mini-review");
    expect(copy).toMatchObject({ based_on: "builtin:mini-review", applies_to: null });
    expect((await svc.listWorkflows("org:a")).map((w) => [w.name, w.applies_to])).toEqual([
      ["Learned review", "equipment-request"],
      ["Copy", null],
    ]);
    expect(await svc.deleteWorkflow("org:b", bound.id)).toBe(false);
    expect(await svc.deleteWorkflow("org:a", "builtin:mini-review")).toBe(false);
    expect(await svc.deleteWorkflow("org:a", bound.id)).toBe(true);
    expect(await svc.getWorkflow("org:a", bound.id)).toBeNull();
    expect(await svc.listVersions("org:a", bound.id)).toEqual([]);
  });

  it("offers a bound workflow only on documents of its type, before the general-report fallback; unbound ones everywhere", async () => {
    const { availableWorkflows, offeredFor } = await import("./availability");
    const { createDocument } = await import("@/lib/documents/store");
    const bound = await svc.createWorkflow("org:a", "Learned review", graph, auth, { appliesTo: "equipment-request" });
    const plain = await svc.createWorkflow("org:a", "Our check", graph, auth);
    const typeDef = { key: "equipment-request", aliases: ["equip_req"] };
    expect(offeredFor({ applies_to: null }, null, null)).toBe(true);
    expect(offeredFor({ applies_to: "equipment-request" }, "equip_req", null)).toBe(false);
    expect(offeredFor({ applies_to: "equip_req" }, "equipment-request", typeDef)).toBe(true);

    const typed = await createDocument("org:a", "ann", { title: "Req", type_key: "equipment-request" });
    const ids = (await availableWorkflows("org:a", typed, typeDef as never)).map((a) => a.id);
    // The generic built-ins, the bound workflow, the fallback type workflow (this team type has no built-in of its own), then the rest.
    expect(ids.indexOf(bound.id)).toBeGreaterThan(-1);
    expect(ids.indexOf(bound.id)).toBeLessThan(ids.indexOf("builtin:type-general-report"));
    expect(ids.at(-1)).toBe(plain.id);

    const other = await createDocument("org:a", "ann", { title: "Proposal", type_key: "proposal" });
    const offered = (await availableWorkflows("org:a", other, null)).map((a) => a.id);
    expect(offered).not.toContain(bound.id);
    expect(offered).toContain(plain.id);
    const untyped = await createDocument("org:a", "ann", { title: "Notes" });
    expect((await availableWorkflows("org:a", untyped, null)).map((a) => a.id)).not.toContain(bound.id);
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
