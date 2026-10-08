import { beforeEach, describe, expect, it, vi } from "vitest";

// The canvas routes: team workflows, copying a built-in, saving (built-ins refused), and "Run on document".
const mocks = vi.hoisted(() => ({
  caller: { teamId: "org:a", agent: "ann@example.com", userId: "u1", orgId: "a", permissions: ["workflow:read", "workflow:write", "workflow:run"] },
  after: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => mocks.caller }));
vi.mock("@/lib/ontology/governance", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ontology/governance")>()), defaultAuditSink: () => ({ write: async () => {} }) }));
vi.mock("@/lib/workflow/engine", () => ({ executeGraph: vi.fn() }));
vi.mock("@/catalog/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/catalog/workflows")>();
  const def = {
    key: "mini",
    version: 2,
    title: "Mini",
    summary: "Mini built-in.",
    kind: "generic",
    appliesTo: [],
    fallback: false,
    outcome: { label: "Result", values: [{ key: "ok", label: "OK" }] },
    checkpoint: null,
    params: [],
    requirementSets: [],
    notAssessed: [],
    notes: [],
    provenance: { source: "test", checked: "2026-10-08" },
    steps: [{ id: "out", node: "outcome.report", config: { rules: [], fallback: "ok" }, in: {}, loop: false }],
  };
  return { ...actual, builtInWorkflows: () => [def], builtInWorkflow: (k: string) => (k === "mini" ? def : null), workflowsForType: () => [def] };
});

import { NextRequest } from "next/server";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { GET as editorGET, PUT as editorPUT } from "../workflow-runs/route";
import { POST as runPOST } from "../workflow-runs/runs/route";
import { GET, POST } from "./route";

const json = (body: unknown, method = "POST") => new NextRequest("http://x/api", { method, body: JSON.stringify(body) });

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  mocks.caller.teamId = "org:a";
});

describe("canvas routes", () => {
  it("lists built-ins beside the team's workflows and copies a built-in to edit", async () => {
    expect(await (await GET()).json()).toEqual({ workflows: [], builtIns: [{ id: "builtin:mini", title: "Mini" }], defaultWorkflowId: "builtin:mini" });
    const res = await POST(json({ name: "My mini", basedOn: "builtin:mini" }));
    expect(res.status).toBe(201);
    const { workflow } = await res.json();
    expect(workflow).toMatchObject({ name: "My mini", based_on: "builtin:mini", latestVersion: 1 });
    expect((await POST(json({ name: "X", basedOn: "builtin:nope" }))).status).toBe(404);

    const editor = await (await editorGET(new NextRequest(`http://x/api/workflow-runs?workflowId=${workflow.id}`))).json();
    expect(editor).toMatchObject({ workflow_id: workflow.id, readOnly: false, builtIns: [{ id: "builtin:mini" }], canEdit: true });
    expect(editor.graph.nodes.map((n: { type: string }) => n.type)).toEqual(["outcome.report"]);

    // Another team sees none of it.
    mocks.caller.teamId = "org:b";
    expect((await (await GET()).json()).workflows).toEqual([]);
    expect((await editorGET(new NextRequest(`http://x/api/workflow-runs?workflowId=${workflow.id}`))).status).toBe(404);
  });

  it("saves a team workflow's new version and refuses a built-in", async () => {
    const { workflow } = await (await POST(json({ name: "Mine" }))).json();
    const saved = await editorPUT(json({ workflowId: workflow.id, graph: defaultWorkflowGraph(), note: "v2" }, "PUT"));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ version: 2, note: "v2" });
    const builtIn = await editorPUT(json({ workflowId: "builtin:mini", graph: defaultWorkflowGraph() }, "PUT"));
    expect(builtIn.status).toBe(409);
    expect((await builtIn.json()).error).toMatch(/copy it first/);
    const shown = await (await editorGET(new NextRequest("http://x/api/workflow-runs?workflowId=builtin:mini"))).json();
    expect(shown).toMatchObject({ readOnly: true, versions: [] });
  });

  it("runs a workflow on one of the team's documents", async () => {
    const doc = await createDocument("org:a", "ann");
    const res = await runPOST(json({ documentId: doc.id, workflowId: "builtin:mini" }));
    expect(res.status).toBe(202);
    expect((await res.json()).run).toMatchObject({ document_id: doc.id, workflow_id: "builtin:mini", workflow_version: 2 });
    expect(mocks.after).toHaveBeenCalled();
    // The team default when none is named.
    expect((await runPOST(json({ documentId: doc.id }))).status).toBe(202);
    expect((await runPOST(json({ groupId: "g1" }))).status).toBe(400);
    mocks.caller.teamId = "org:b";
    expect((await runPOST(json({ documentId: doc.id, workflowId: "builtin:mini" }))).status).toBe(404);
  });
});
