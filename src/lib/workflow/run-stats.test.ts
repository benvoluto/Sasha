import { describe, expect, it } from "vitest";
import { formatDuration, runOutcome, runTimeline, summarizeRuns, type RunSummary } from "./run-stats";

const t = (s: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, s)).toISOString();
const nodes = [
  { id: "sources", type: "sources.read", label: "Source passages" },
  { id: "summarize", type: "ai.ask", label: "Summarize" },
  { id: "check", type: "checkpoint", label: "Human checkpoint" },
  { id: "output", type: "outcome.report", label: "Outcome" },
];
const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "r1",
  document_id: "d1",
  status: "complete",
  workflow_id: "default",
  workflow_name: "Default workflow",
  workflow_version: 2,
  requested_by: "a@example.com",
  created_at: t(0),
  updated_at: t(60),
  checkpoints: {},
  outcome: null,
  nodes,
  steps: {
    sources: { status: "done", startedAt: t(0), finishedAt: t(2) },
    summarize: { status: "done", startedAt: t(2), finishedAt: t(12) },
    check: { status: "done", startedAt: t(12), finishedAt: t(50) },
    output: { status: "done", startedAt: t(50), finishedAt: t(51) },
  },
  ...over,
});

describe("runOutcome", () => {
  it("reads a superseded run's outcome back from its steps", () => {
    expect(runOutcome(run({ status: "superseded" }))).toBe("complete");
    expect(runOutcome(run({ status: "superseded", steps: { summarize: { status: "failed", error: "x" }, output: { status: "skipped" } } }))).toBe("failed");
    expect(runOutcome(run({ status: "superseded", steps: { sources: { status: "done" }, summarize: { status: "running" } } }))).toBe("stopped");
    expect(runOutcome(run({ status: "paused" }))).toBe("paused");
  });
});

describe("summarizeRuns", () => {
  const o = summarizeRuns([
    run(),
    run({ id: "r2" }),
    run({ id: "r3", status: "failed", steps: { sources: { status: "failed", startedAt: t(0), finishedAt: t(1), error: "no documents" }, output: { status: "skipped" } } }),
    run({ id: "r4", workflow_version: 1 }),
  ]);

  it("counts outcomes and errors", () => {
    expect(o.total).toBe(4);
    expect(o.byOutcome.complete).toBe(3);
    expect(o.byOutcome.failed).toBe(1);
    expect(o.topErrors).toEqual([{ label: "Source passages", error: "no documents", count: 1 }]);
  });

  it("breaks step timings down per version, slowest first, leaving out checkpoints", () => {
    expect(o.versions.map((v) => v.version)).toEqual([2, 1]);
    const v2 = o.versions[0];
    expect(v2.runs).toBe(3);
    expect(v2.failed).toBe(1);
    expect(v2.steps.map((s) => s.nodeId)).toEqual(["summarize", "sources", "output"]);
    const sources = v2.steps.find((s) => s.nodeId === "sources")!;
    expect(sources).toMatchObject({ runs: 3, failed: 1, min: 1000, max: 2000 });
    expect(sources.avg).toBeCloseTo(5000 / 3);
  });
});

describe("runTimeline", () => {
  it("lists the start, each step, checkpoint decisions and the end in time order", () => {
    const decision = { verdict: "reject" as const, excluded: [1], note: "drop one", by: "b@example.com", at: t(49), role: "Supervisor", edits: null };
    const entries = runTimeline(run({ checkpoints: { check: decision } }));
    expect(entries.map((e) => e.title)).toEqual([
      "Run started",
      "Source passages finished in 2.00 s",
      "Summarize finished in 10.0 s",
      "b@example.com rejected Human checkpoint",
      "Human checkpoint finished in 38.0 s",
      "Outcome finished in 1.00 s",
      "Run finished: outcome recorded",
    ]);
    expect(entries.at(-1)!.detail).toBe("total 1m 0s");
  });

  it("carries a failed step's error", () => {
    const entries = runTimeline(run({ status: "failed", steps: { sources: { status: "failed", startedAt: t(0), finishedAt: t(1), error: "no documents" } } }));
    expect(entries.find((e) => e.status === "failed")).toMatchObject({ title: "Source passages failed in 1.00 s", detail: "no documents" });
  });
});

describe("formatDuration", () => {
  it("formats across scales", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});
