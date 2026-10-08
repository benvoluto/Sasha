import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  caller: { teamId: "org:a", agent: "ann@example.com", userId: "u1", orgId: "a", permissions: [] as string[] },
  after: vi.fn(),
  audit: vi.fn(async () => {}),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => mocks.caller }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: mocks.audit }) }));
vi.mock("@/lib/workflow/engine", () => ({ executeGraph: vi.fn() }));
// A small catalog of built-ins, so these tests don't depend on the shipped definitions.
vi.mock("@/catalog/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/catalog/workflows")>();
  const def = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    version: 1,
    title: key,
    summary: `${key} summary`,
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
    ...over,
  });
  const all = [
    def("draft-all"),
    def("restructure", { params: ["targetType", "mode"], checkpoint: { role: "Author", required: true } }),
    def("type-nih", { kind: "type", appliesTo: ["nih-specific-aims-research-strategy"], checkpoint: null }),
  ];
  const workflowsForType = (typeKey: string | null) => [...all.filter((w) => w.kind === "generic"), ...(typeKey ? all.filter((w) => w.kind === "type" && (w.appliesTo as string[]).includes(typeKey)) : [])];
  return { ...actual, builtInWorkflows: () => all, builtInWorkflow: (k: string) => all.find((w) => w.key === k) ?? null, workflowsForType };
});

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { DRAFT_ALL_ACK } from "@/lib/workflow/availability";
import type { DocumentWorkflowsResponse, RunResponse } from "@/lib/workflow/contract";
import { createWorkflow, getRun, saveWorkflow } from "@/lib/workflow/store";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { GET, POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request(`http://x/api/documents/${id}/workflows`), ctx(id));
const post = (id: string, body: unknown) => POST(new Request(`http://x/api/documents/${id}/workflows`, { method: "POST", body: JSON.stringify(body) }), ctx(id));

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  mocks.caller.teamId = "org:a";
  mocks.after.mockClear();
  mocks.audit.mockClear();
});

describe("GET /api/documents/[id]/workflows", () => {
  it("lists generic workflows first, then the type's, then the team's, with the policy applied", async () => {
    const doc = await createDocument("org:a", "ann", { title: "Aims", type_key: "nih-specific-aims-research-strategy" });
    await createWorkflow("org:a", "Our check", defaultWorkflowGraph(), mocks.caller);
    const res = await get(doc.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentWorkflowsResponse;
    expect(body).toMatchObject({ documentId: doc.id, typeKey: "nih-specific-aims-research-strategy", runs: [] });
    expect(body.available.map((a) => [a.id, a.kind])).toEqual([
      ["builtin:draft-all", "generic"],
      ["builtin:restructure", "generic"],
      ["builtin:type-nih", "type"],
      [expect.stringMatching(/^our-check-/), "team"],
    ]);
    const draft = body.available[0];
    expect(draft).toMatchObject({ enabled: false, acknowledge: { key: DRAFT_ALL_ACK, text: expect.stringMatching(/notes/) } });
    expect(draft.disabledReason).toMatch(/NOT-OD-25-132/);
    expect(body.available[1]).toMatchObject({ params: ["targetType", "mode"], checkpoint: { role: "Author", required: true }, enabled: true });
    expect(body.available[3]).toMatchObject({ outcome: { label: "Result", values: [{ key: "sound" }, { key: "gaps_found" }] }, params: [] });
  });

  it("leaves type workflows off an untyped document, and 404s another team's document", async () => {
    const doc = await createDocument("org:a", "ann");
    const body = (await (await get(doc.id)).json()) as DocumentWorkflowsResponse;
    expect(body.available.map((a) => a.key)).toEqual(["draft-all", "restructure"]);
    expect(body.available[0].enabled).toBe(true);
    mocks.caller.teamId = "org:b";
    expect((await get(doc.id)).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });
});

describe("POST /api/documents/[id]/workflows", () => {
  it("starts a run (202) and continues it in after()", async () => {
    const doc = await createDocument("org:a", "ann", { title: "Plan" });
    const res = await post(doc.id, { workflowId: "builtin:draft-all" });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as RunResponse;
    expect(run).toMatchObject({ document_id: doc.id, workflow_id: "builtin:draft-all", status: "running", requested_by: "ann@example.com", proposed: [] });
    expect(run).not.toHaveProperty("team_id");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect((await getRun("org:a", run.id))?.workflow_id).toBe("builtin:draft-all");
    // The history lists it.
    expect(((await (await get(doc.id)).json()) as DocumentWorkflowsResponse).runs.map((r) => r.id)).toEqual([run.id]);
  });

  it("refuses a workflow the type's policy turns off with 409 unless the notice is acknowledged", async () => {
    const doc = await createDocument("org:a", "ann", { type_key: "nih-specific-aims-research-strategy" });
    const refused = await post(doc.id, { workflowId: "builtin:draft-all" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/NOT-OD-25-132/), acknowledge: { key: DRAFT_ALL_ACK } });
    expect((await post(doc.id, { workflowId: "builtin:draft-all", params: { acknowledge: ["something-else"] } })).status).toBe(409);
    expect(mocks.after).not.toHaveBeenCalled();

    const ok = await post(doc.id, { workflowId: "builtin:draft-all", params: { acknowledge: [DRAFT_ALL_ACK] } });
    expect(ok.status).toBe(202);
    const { run } = (await ok.json()) as RunResponse;
    expect(run.params).toEqual({ acknowledge: [DRAFT_ALL_ACK] });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow_policy_acknowledged", agent: "ann@example.com", args: { documentId: doc.id, runId: run.id } }));
  });

  it("applies the draft-all policy to a team workflow that drafts sections, whatever it is called", async () => {
    const doc = await createDocument("org:a", "ann", { type_key: "nih-specific-aims-research-strategy" });
    const graph = defaultWorkflowGraph();
    graph.nodes.push({ id: "draft", type: "draft.section", position: { x: 0, y: 0 }, config: {}, loop: true, expanded: false });
    const copy = await createWorkflow("org:a", "Fill it in", graph, mocks.caller, "builtin:draft-all");
    const plain = await createWorkflow("org:a", "Our check", defaultWorkflowGraph(), mocks.caller);

    const listed = ((await (await get(doc.id)).json()) as DocumentWorkflowsResponse).available;
    expect(listed.find((a) => a.id === copy.id)).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/NOT-OD-25-132/), acknowledge: { key: DRAFT_ALL_ACK } });
    expect(listed.find((a) => a.id === plain.id)).toMatchObject({ enabled: true, acknowledge: null });

    const refused = await post(doc.id, { workflowId: copy.id });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ acknowledge: { key: DRAFT_ALL_ACK } });
    expect(mocks.after).not.toHaveBeenCalled();

    const ok = await post(doc.id, { workflowId: copy.id, params: { acknowledge: [DRAFT_ALL_ACK] } });
    expect(ok.status).toBe(202);
    const { run } = (await ok.json()) as RunResponse;
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow_policy_acknowledged", args: { documentId: doc.id, runId: run.id } }));

    // An untyped document has no such policy.
    const untyped = await createDocument("org:a", "ann");
    expect((await post(untyped.id, { workflowId: copy.id })).status).toBe(202);
  });

  it("judges a team workflow on the version being run", async () => {
    const doc = await createDocument("org:a", "ann", { type_key: "nih-specific-aims-research-strategy" });
    const graph = defaultWorkflowGraph();
    graph.nodes.push({ id: "draft", type: "draft.section", position: { x: 0, y: 0 }, config: {}, loop: true, expanded: false });
    const w = await createWorkflow("org:a", "Fill it in", graph, mocks.caller);
    await saveWorkflow("org:a", w.id, defaultWorkflowGraph(), "No drafting", mocks.caller);
    expect((await post(doc.id, { workflowId: w.id })).status).toBe(202);
    expect((await post(doc.id, { workflowId: w.id, version: 1 })).status).toBe(409);
  });

  it("checks restructure's params: an enabled target type, mode merge by default", async () => {
    const doc = await createDocument("org:a", "ann");
    expect(await (await post(doc.id, { workflowId: "builtin:restructure" })).json()).toEqual({ error: "Choose a type to restructure to." });
    expect((await post(doc.id, { workflowId: "builtin:restructure", params: { targetType: "no-such-type" } })).status).toBe(400);
    const res = await post(doc.id, { workflowId: "builtin:restructure", params: { targetType: "proposal" } });
    expect(res.status).toBe(202);
    expect(((await res.json()) as RunResponse).run.params).toEqual({ targetType: "proposal", mode: "merge" });
    // Params a workflow doesn't declare are dropped.
    const plain = await post(doc.id, { workflowId: "builtin:draft-all", params: { targetType: "proposal", mode: "rewrite" } });
    expect(((await plain.json()) as RunResponse).run.params).toEqual({});
  });

  it("400s a workflow that doesn't apply, 404s an unknown one or another team's document", async () => {
    const doc = await createDocument("org:a", "ann");
    expect((await post(doc.id, { workflowId: "builtin:type-nih" })).status).toBe(400);
    expect((await post(doc.id, { workflowId: "builtin:nope" })).status).toBe(400);
    expect((await post(doc.id, { workflowId: "someone-elses-1234" })).status).toBe(404);
    expect((await post(doc.id, { nope: true })).status).toBe(400);
    mocks.caller.teamId = "org:b";
    expect((await post(doc.id, { workflowId: "builtin:draft-all" })).status).toBe(404);
  });
});
