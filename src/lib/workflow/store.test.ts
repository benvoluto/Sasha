import { describe, expect, it } from "vitest";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { STALE_RUN_MS, withStaleCheck, type WorkflowRun } from "./store";

const run = (status: WorkflowRun["status"], updatedAgoMs: number, now: number): WorkflowRun => ({
  id: "r1",
  group_id: "g1",
  status,
  workflow_id: "default",
  workflow_name: "Default workflow",
  workflow_version: 0,
  workflow: defaultWorkflowGraph(),
  steps: { sources: { status: "done" }, summarize: { status: "running" }, output: { status: "pending" } },
  outputs: {},
  checkpoints: {},
  raw: {},
  requested_by: "x",
  created_at: new Date(now - updatedAgoMs).toISOString(),
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
    expect(r.steps.output.status).toBe("failed");
  });

  it("never touches runs that are waiting or finished", () => {
    for (const status of ["awaiting_review", "paused", "draft"] as const) {
      const r = run(status, STALE_RUN_MS * 10, now);
      expect(withStaleCheck(r, now)).toBe(r);
    }
  });
});
