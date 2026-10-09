import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  caller: { teamId: "org:a", agent: "sup@example.com", userId: "u1", orgId: "a", permissions: [] as string[] },
  after: vi.fn(),
  audit: vi.fn(async () => {}),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => mocks.caller }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: mocks.audit }) }));
vi.mock("@/lib/workflow/engine", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/workflow/engine")>()), executeGraph: vi.fn() }));

import { resetMemoryStore } from "@/lib/documents/store";
import type { RunResponse, WorkflowRunRecord } from "@/lib/workflow/contract";
import { NODE_SPEC_INDEX } from "@/lib/workflow/registry";
import { createRun, getRun, saveRun } from "@/lib/workflow/store";
import type { GraphNode } from "@/lib/workflow/types";
import { GET } from "../route";
import { POST } from "./route";

const DOC = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";
const node = (id: string, type: string, config: Record<string, unknown> = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config: { ...NODE_SPEC_INDEX[type].defaults(), ...config }, loop: false, expanded: false });

/** A run stopped at a signing checkpoint that asks for the approver's name. */
async function awaiting(editable: "none" | "outcome" = "outcome", extra: Record<string, unknown> = {}): Promise<WorkflowRunRecord> {
  const graph = {
    format: "graph-v1" as const,
    nodes: [
      node("outcome", "outcome.report"),
      node("cp", "checkpoint", { role: "Supervisor", signsOutcome: true, editable, recordFields: [{ key: "signed_name", label: "Name and credential", required: true }], ...extra }),
    ],
    edges: [{ id: "e1", source: "outcome", sourceHandle: "outcome", target: "cp", targetHandle: "items" }],
  };
  const run = await createRun("org:a", DOC, { workflow_id: "builtin:type-x", name: "X", version: 1, graph, note: "", created_by: "x", created_at: "", readOnly: true, based_on: null }, {}, mocks.caller);
  run.steps = { outcome: { status: "done" }, cp: { status: "waiting" } };
  run.outputs = { cp: { pending_items: [{ value: "sound" }] } };
  run.status = "awaiting_review";
  await saveRun(run);
  return run;
}

const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });
const cont = (runId: string, body?: unknown) =>
  POST(new Request(`http://x/api/workflow-runs/runs/${runId}/continue`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) as never, ctx(runId));

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  mocks.caller.teamId = "org:a";
  mocks.caller.agent = "sup@example.com";
  mocks.after.mockClear();
  mocks.audit.mockClear();
});

describe("POST /api/workflow-runs/runs/[runId]/continue", () => {
  it("records an approval with who, when and role, and resumes the run", async () => {
    const run = await awaiting();
    const res = await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "approve", note: "Looks right", edits: { record: { signed_name: "Dr. Sue, LSSP", extra: "dropped" } } } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as RunResponse;
    expect(body.run.status).toBe("running");
    const stored = (await getRun("org:a", run.id))!;
    expect(stored.checkpoints.cp).toMatchObject({ verdict: "approve", note: "Looks right", by: "sup@example.com", role: "Supervisor", excluded: [], edits: { record: { signed_name: "Dr. Sue, LSSP" } } });
    expect(stored.steps.cp.status).toBe("pending");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow_checkpoint_decided", agent: "sup@example.com", args: { documentId: DOC, runId: run.id } }));
    // A second click finds it already continued.
    expect((await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "approve", edits: { record: { signed_name: "S" } } } })).status).toBe(409);
  });

  it("waits for every named signer, one person per signer, before the decision is final", async () => {
    const signers = [{ key: "owner", label: "Process owner" }, { key: "quality", label: "Quality approver" }];
    const run = await awaiting("outcome", { signers });
    const sign = (signer: string | undefined, verdict = "approve", note = "") => cont(run.id, { checkpoint: { nodeId: "cp", verdict, note, signer, edits: verdict === "reject" ? undefined : { record: { signed_name: "S" } } } });

    expect(await (await sign(undefined)).json()).toEqual({ error: "Say who you are signing as: Process owner or Quality approver." });
    const first = await sign("owner", "approve", "Fine by me");
    expect(first.status).toBe(202);
    expect(((await first.json()) as RunResponse).run.status).toBe("awaiting_review");
    let stored = (await getRun("org:a", run.id))!;
    expect(stored.checkpoints.cp).toBeUndefined();
    expect(stored.steps.cp.status).toBe("waiting");
    expect(stored.outputs.cp).toMatchObject({ pending_items: [{ value: "sound" }], signatures: [{ signer: "owner", label: "Process owner", verdict: "approve", by: "sup@example.com", note: "Fine by me" }] });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow_checkpoint_signed" }));

    // The same signer can't sign twice, nor one person for both.
    expect(await (await sign("owner")).json()).toEqual({ error: "Process owner has already signed." });
    expect((await sign("quality")).status).toBe(400);

    mocks.caller.agent = "qa@example.com";
    const second = await sign("quality", "edit");
    expect(second.status).toBe(202);
    stored = (await getRun("org:a", run.id))!;
    expect(stored.checkpoints.cp).toMatchObject({ verdict: "edit", by: "sup@example.com, qa@example.com", role: "Supervisor", note: "Process owner: Fine by me" });
    expect(stored.checkpoints.cp.signatures?.map((g) => [g.signer, g.by])).toEqual([["owner", "sup@example.com"], ["quality", "qa@example.com"]]);
    expect(stored.steps.cp.status).toBe("pending");
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("a rejection from any named signer decides at once", async () => {
    const run = await awaiting("outcome", { signers: [{ key: "owner", label: "Process owner" }, { key: "quality", label: "Quality approver" }] });
    const res = await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "reject", note: "Not yet", signer: "quality" } });
    expect(res.status).toBe(202);
    expect((await getRun("org:a", run.id))!.checkpoints.cp).toMatchObject({ verdict: "reject", by: "sup@example.com", signatures: [{ signer: "quality" }] });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("enforces required record fields, allowed verdicts and outcome values", async () => {
    const run = await awaiting();
    const missing = await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "approve" } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Fill in “Name and credential”." });
    expect((await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "edit", edits: { outcomeValue: "excellent", record: { signed_name: "S" } } } })).status).toBe(400);
    expect((await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "edit", edits: { targets: { R1: "aims" }, record: { signed_name: "S" } } } })).status).toBe(400);
    expect((await cont(run.id, { checkpoint: { nodeId: "outcome", verdict: "approve" } })).status).toBe(400);
    expect((await cont(run.id, {})).status).toBe(400);
    expect((await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "maybe" } })).status).toBe(400);
    expect(mocks.after).not.toHaveBeenCalled();

    const ok = await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "edit", edits: { outcomeValue: "gaps_found", record: { signed_name: "S" } } } });
    expect(ok.status).toBe(202);
    expect((await getRun("org:a", run.id))!.checkpoints.cp.edits).toEqual({ outcomeValue: "gaps_found", record: { signed_name: "S" } });

    const locked = await awaiting("none");
    expect((await cont(locked.id, { checkpoint: { nodeId: "cp", verdict: "edit", edits: { record: { signed_name: "S" } } } })).status).toBe(400);
    // A rejection needs no record.
    expect((await cont(locked.id, { checkpoint: { nodeId: "cp", verdict: "reject", note: "Redo" } })).status).toBe(202);
  });

  it("resumes a paused run with no body, and retries a failed one", async () => {
    const run = await awaiting();
    run.status = "paused";
    run.pause_reason = "budget";
    await saveRun(run);
    expect((await cont(run.id)).status).toBe(202);
    expect((await getRun("org:a", run.id))).toMatchObject({ status: "running", pause_reason: null });

    const failed = await awaiting();
    failed.status = "failed";
    failed.steps = { outcome: { status: "failed", error: "boom" }, cp: { status: "skipped" } };
    await saveRun(failed);
    expect((await cont(failed.id)).status).toBe(202);
    expect((await getRun("org:a", failed.id))!.steps).toEqual({ outcome: { status: "pending" }, cp: { status: "pending" } });

    const done = await awaiting();
    done.status = "complete";
    await saveRun(done);
    expect((await cont(done.id)).status).toBe(409);
    expect((await cont(done.id, "{not json")).status).toBe(400);
  });

  it("404s another team's run, here and when polling", async () => {
    const run = await awaiting();
    mocks.caller.teamId = "org:b";
    expect((await cont(run.id, { checkpoint: { nodeId: "cp", verdict: "approve" } })).status).toBe(404);
    expect((await GET(new Request("http://x") as never, ctx(run.id))).status).toBe(404);
    mocks.caller.teamId = "org:a";
    const polled = await GET(new Request("http://x") as never, ctx(run.id));
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as RunResponse).run.id).toBe(run.id);
  });
});

describe("POST /api/workflow-runs/runs/[runId]/continue rate limit", () => {
  beforeEach(() => {
    process.env.SASHA_LIMIT_WORKFLOW_USER = "1/1h";
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_WORKFLOW_USER;
  });

  // A long run pauses at the time budget every 200 s; charging each continue spent the hourly allowance mid-run.
  it("checkpoint decisions and pauses cost nothing, however often a run pauses", async () => {
    const signers = [{ key: "owner", label: "Process owner" }, { key: "quality", label: "Quality approver" }];
    const signing = await awaiting("outcome", { signers });
    expect((await cont(signing.id, { checkpoint: { nodeId: "cp", verdict: "approve", signer: "owner", edits: { record: { signed_name: "S" } } } })).status).toBe(202);
    mocks.caller.agent = "qa@example.com";
    expect((await cont(signing.id, { checkpoint: { nodeId: "cp", verdict: "approve", signer: "quality", edits: { record: { signed_name: "Q" } } } })).status).toBe(202);

    // Starting another run of the workflow supersedes the earlier ones, so one run pauses many times.
    const paused = await awaiting();
    for (let i = 0; i < 5; i++) {
      const again = (await getRun("org:a", paused.id))!;
      again.status = "paused";
      again.pause_reason = i % 2 ? "manual" : "budget";
      await saveRun(again);
      expect((await cont(paused.id)).status).toBe(202);
    }
    expect(mocks.after).toHaveBeenCalledTimes(6);
  });

  it("counts a retry of a failed run; a refused retry costs nothing; the 429 leaves the run failed", async () => {
    const failedRun = async () => {
      const r = await awaiting();
      r.status = "failed";
      r.steps = { outcome: { status: "failed", error: "boom" }, cp: { status: "skipped" } };
      await saveRun(r);
      return r;
    };
    const done = await awaiting();
    done.status = "complete";
    await saveRun(done);
    expect((await cont(done.id)).status).toBe(409);

    const first = await failedRun();
    expect((await cont(first.id)).status).toBe(202);
    const second = await failedRun();
    const res = await cont(second.id);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ code: "rate_limited", scope: "user", family: "workflow" });
    expect((await getRun("org:a", second.id))?.status).toBe("failed");
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });
});
