import { beforeEach, describe, expect, it, vi } from "vitest";

// Covers both per-run responses: changes (this route) and findings (../findings).
const mocks = vi.hoisted(() => ({
  caller: { teamId: "org:a", agent: "ann@example.com", userId: "u1", orgId: "a", permissions: [] as string[] },
  audit: vi.fn(async () => {}),
}));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => mocks.caller }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: mocks.audit }) }));

import { resetMemoryStore } from "@/lib/documents/store";
import type { Finding, Outcome, RunResponse, WorkflowRunRecord } from "@/lib/workflow/contract";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { createRun, getRun, saveRun } from "@/lib/workflow/store";
import { POST as findingsPOST } from "../findings/route";
import { POST } from "./route";

const DOC = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";
const finding = { id: "check:1", nodeId: "check", kind: "gap", severity: "major", title: "Missing owner" } as Finding;

async function finished(): Promise<WorkflowRunRecord> {
  const graph = defaultWorkflowGraph();
  graph.nodes.push({ id: "write", type: "doc.write", position: { x: 0, y: 0 }, config: {}, loop: false, expanded: false });
  const run = await createRun("org:a", DOC, { workflow_id: "wf-1", name: "W", version: 1, graph, note: "", created_by: "x", created_at: "", readOnly: false, based_on: null }, {}, mocks.caller);
  run.status = "complete";
  run.outputs.write = { change: { id: "write", title: "Drafts", summary: "", ops: [], basisUpdatedAt: "", snapshotReason: "Before" } };
  run.outcome = { value: "gaps_found", findings: [finding] } as unknown as Outcome;
  await saveRun(run);
  return run;
}

const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });
const change = (runId: string, body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }) as never, ctx(runId));
const respond = (runId: string, body: unknown) => findingsPOST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }) as never, ctx(runId));

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  mocks.caller.teamId = "org:a";
  mocks.audit.mockClear();
});

describe("POST /api/workflow-runs/runs/[runId]/changes", () => {
  it("records what happened to a proposed change, with who and when, and audits it", async () => {
    const run = await finished();
    const res = await change(run.id, { changeId: "write", result: "applied", detail: "2 sections" });
    expect(res.status).toBe(200);
    const { run: view } = (await res.json()) as RunResponse;
    expect(view.changes.write).toMatchObject({ result: "applied", by: "ann@example.com", detail: "2 sections" });
    expect(view.proposed.map((c) => c.id)).toEqual(["write"]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow_change_applied", args: { documentId: DOC, runId: run.id } }));
    expect((await getRun("org:a", run.id))!.changes.write.result).toBe("applied");
  });

  it("400s an unknown change or result, 404s another team's run", async () => {
    const run = await finished();
    expect((await change(run.id, { changeId: "nope", result: "applied" })).status).toBe(400);
    expect((await change(run.id, { changeId: "write", result: "kept" })).status).toBe(400);
    mocks.caller.teamId = "org:b";
    expect((await change(run.id, { changeId: "write", result: "discarded" })).status).toBe(404);
  });
});

describe("POST /api/workflow-runs/runs/[runId]/findings", () => {
  it("records the author's response to a finding", async () => {
    const run = await finished();
    const res = await respond(run.id, { findingId: "check:1", state: "dismissed" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RunResponse).run.responses["check:1"]).toMatchObject({ state: "dismissed", by: "ann@example.com" });
    await respond(run.id, { findingId: "check:1", state: "open" });
    expect((await getRun("org:a", run.id))!.responses["check:1"].state).toBe("open");
  });

  it("400s an unknown finding, 404s another team's run", async () => {
    const run = await finished();
    expect((await respond(run.id, { findingId: "check:9", state: "accepted" })).status).toBe(400);
    mocks.caller.teamId = "org:b";
    expect((await respond(run.id, { findingId: "check:1", state: "accepted" })).status).toBe(404);
  });
});
