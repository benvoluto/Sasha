import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import type { WorkflowRunRecord } from "./contract";

vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));

const { resetMemoryStore } = await import("@/lib/documents/store");
const svc = await import("./store");
const { STALE_RUN_MS, withStaleCheck } = svc;

const auth = { agent: "a@example.com", permissions: [] };
const DOC = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";
const DOC2 = "11111111-1111-4111-8111-111111111111";
const workflow = (id = "wf-1") => ({ workflow_id: id, name: `Workflow ${id}`, version: 1, graph: defaultWorkflowGraph(), note: "", created_by: "x", created_at: "", readOnly: false, based_on: null });

const run = (status: WorkflowRunRecord["status"], updatedAgoMs: number, now: number) => ({
  status,
  steps: { sources: { status: "done" as const }, summarize: { status: "running" as const }, outcome: { status: "pending" as const } },
  updated_at: new Date(now - updatedAgoMs).toISOString(),
});

describe("withStaleCheck", () => {
  const now = Date.now();

  it("leaves a run that is still making progress alone", () => {
    const r = run("running", 60_000, now);
    expect(withStaleCheck(r, now)).toBe(r);
  });

  it("reports a run that stopped responding as failed, keeping finished steps", () => {
    const r = withStaleCheck(run("running", STALE_RUN_MS + 1, now), now)!;
    expect(r.status).toBe("failed");
    expect(r.steps.sources.status).toBe("done");
    expect(r.steps.summarize).toMatchObject({ status: "failed", error: expect.stringMatching(/stopped responding/) });
    expect(r.steps.outcome.status).toBe("failed");
  });

  it("never touches runs that are waiting or finished", () => {
    for (const status of ["awaiting_review", "paused", "complete"] as const) {
      const r = run(status, STALE_RUN_MS * 10, now);
      expect(withStaleCheck(r, now)).toBe(r);
    }
  });
});

describe("runs", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("records which workflow, version and params a run used, and keeps it to the team", async () => {
    const r = await svc.createRun("org:a", DOC, workflow(), { mode: "merge" }, auth);
    expect(r).toMatchObject({ team_id: "org:a", document_id: DOC, status: "running", workflow_id: "wf-1", workflow_name: "Workflow wf-1", workflow_version: 1, params: { mode: "merge" }, outcome: null });
    expect(Object.values(r.steps).every((s) => s.status === "pending")).toBe(true);
    expect((await svc.getRun("org:a", r.id))?.id).toBe(r.id);
    expect(await svc.getRun("org:b", r.id)).toBeNull();
    expect(await svc.listDocumentRuns("org:b", DOC)).toEqual([]);
    expect(await svc.recentRunSummaries("org:b", 10)).toEqual([]);
  });

  it("supersedes only active runs of the same workflow on the same document", async () => {
    const first = await svc.createRun("org:a", DOC, workflow("wf-1"), {}, auth);
    const otherWorkflow = await svc.createRun("org:a", DOC, workflow("wf-2"), {}, auth);
    const otherDoc = await svc.createRun("org:a", DOC2, workflow("wf-1"), {}, auth);
    const done = await svc.createRun("org:a", DOC, workflow("wf-3"), {}, auth);
    done.status = "complete";
    await svc.saveRun(done);
    await svc.createRun("org:a", DOC, workflow("wf-3"), {}, auth);
    const second = await svc.createRun("org:a", DOC, workflow("wf-1"), {}, auth);

    expect((await svc.getRun("org:a", first.id))?.status).toBe("superseded");
    expect((await svc.getRun("org:a", second.id))?.status).toBe("running");
    expect((await svc.getRun("org:a", otherWorkflow.id))?.status).toBe("running");
    expect((await svc.getRun("org:a", otherDoc.id))?.status).toBe("running");
    expect((await svc.getRun("org:a", done.id))?.status).toBe("complete");

    // The superseded run's engine can't write it back.
    first.status = "complete";
    await svc.saveRun(first);
    expect(first.status).toBe("superseded");
    expect((await svc.getRun("org:a", first.id))?.status).toBe("superseded");
  });

  it("lists a document's runs newest first and the latest per workflow", async () => {
    const a1 = await svc.createRun("org:a", DOC, workflow("wf-1"), {}, auth);
    const b1 = await svc.createRun("org:a", DOC, workflow("wf-2"), {}, auth);
    const a2 = await svc.createRun("org:a", DOC, workflow("wf-1"), {}, auth);
    const briefs = await svc.listDocumentRuns("org:a", DOC);
    expect(briefs.map((b) => b.id)).toEqual([a2.id, b1.id, a1.id]);
    expect(briefs[0]).not.toHaveProperty("outputs");
    const latest = await svc.latestRuns("org:a", DOC);
    expect(Object.keys(latest).sort()).toEqual(["wf-1", "wf-2"]);
    expect(latest["wf-1"].id).toBe(a2.id);
    expect((await svc.recentRunSummaries("org:a", 2)).map((s) => s.id)).toEqual([a2.id, b1.id]);
  });

  it("records change results and finding responses without a running engine overwriting them", async () => {
    const r = await svc.createRun("org:a", DOC, workflow(), {}, auth);
    const at = new Date().toISOString();
    expect(await svc.recordChangeResult("org:b", r.id, "write", { result: "applied", by: "x", at, detail: "" })).toBeNull();
    const changed = await svc.recordChangeResult("org:a", r.id, "write", { result: "applied", by: "a@example.com", at, detail: "" });
    expect(changed?.changes.write).toMatchObject({ result: "applied" });
    await svc.recordFindingResponse("org:a", r.id, "check:1", { state: "dismissed", by: "a@example.com", at });
    // The engine's copy has neither; saving it keeps them.
    r.status = "complete";
    await svc.saveRun(r);
    const stored = (await svc.getRun("org:a", r.id))!;
    expect(stored.status).toBe("complete");
    expect(stored.changes.write.result).toBe("applied");
    expect(stored.responses["check:1"].state).toBe("dismissed");
  });

  it("claims a run once", async () => {
    const r = await svc.createRun("org:a", DOC, workflow(), {}, auth);
    r.status = "paused";
    r.pause_reason = "budget";
    await svc.saveRun(r);
    const a = (await svc.getRun("org:a", r.id))!;
    const b = (await svc.getRun("org:a", r.id))!;
    expect(await svc.claimRun(a, ["paused"])).toBe(true);
    expect(a).toMatchObject({ status: "running", pause_reason: null });
    expect(await svc.claimRun(b, ["paused"])).toBe(false);
  });

  it("claims a failed run once on retry, even though retry also accepts a stalled running run", async () => {
    const r = await svc.createRun("org:a", DOC, workflow(), {}, auth);
    r.status = "failed";
    await svc.saveRun(r);
    const a = (await svc.getRun("org:a", r.id))!;
    const b = (await svc.getRun("org:a", r.id))!;
    expect(await svc.claimRun(a, ["failed", "running"])).toBe(true);
    // b read "failed" before a claimed it; the row is now freshly running.
    expect(await svc.claimRun(b, ["failed", "running"])).toBe(false);
  });

  it("claims a stalled running run once on retry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const r = await svc.createRun("org:a", DOC, workflow(), {}, auth);
      vi.setSystemTime(new Date(Date.now() + STALE_RUN_MS + 1000));
      const a = (await svc.getRun("org:a", r.id))!;
      const b = (await svc.getRun("org:a", r.id))!;
      expect(a.status).toBe("failed");
      expect(await svc.claimRun(a, ["failed", "running"])).toBe(true);
      expect(await svc.claimRun(b, ["failed", "running"])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the client view: no team or raw replies, plus the doc.write changes in graph order", async () => {
    const graph = defaultWorkflowGraph();
    graph.nodes.push({ id: "write", type: "doc.write", position: { x: 0, y: 0 }, config: {}, loop: false, expanded: false });
    const r = await svc.createRun("org:a", DOC, { ...workflow(), graph }, {}, auth);
    r.raw.summarize = "bad reply";
    r.outputs.write = { change: { id: "write", title: "T", summary: "", ops: [], basisUpdatedAt: "", snapshotReason: "" } };
    r.outputs.summarize = { change: { id: "not-a-write", ops: [] } };
    const view = svc.runView(r);
    expect(view).not.toHaveProperty("team_id");
    expect(view).not.toHaveProperty("raw");
    expect(view.proposed.map((c) => c.id)).toEqual(["write"]);
  });

  it("clears with the document store's reset", async () => {
    const r = await svc.createRun("org:a", DOC, workflow(), {}, auth);
    resetMemoryStore();
    expect(await svc.getRun("org:a", r.id)).toBeNull();
  });
});
