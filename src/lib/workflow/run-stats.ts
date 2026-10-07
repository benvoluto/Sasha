// Run history for the Run log and Overview tabs: what each run ended as, how
// long it and its steps took, and totals across runs. Pure functions over run
// summaries, shared by the server (which builds the summaries) and the client.

import { CHECKPOINT_NODE_TYPE, NODE_SPEC_INDEX, OUTPUT_NODE_TYPE } from "./registry";
import type { RunStatus, StepState, WorkflowRun } from "./store";

/** A run without its node outputs: enough for the history views, small enough to list hundreds. */
export type RunSummary = Pick<WorkflowRun, "id" | "group_id" | "status" | "workflow_id" | "workflow_name" | "workflow_version" | "steps" | "checkpoints" | "requested_by" | "created_at" | "updated_at"> & {
  /** The run's nodes, in workflow order. */
  nodes: Array<{ id: string; type: string; label: string }>;
};

export function toRunSummary(run: WorkflowRun): RunSummary {
  return {
    id: run.id,
    group_id: run.group_id,
    status: run.status,
    workflow_id: run.workflow_id,
    workflow_name: run.workflow_name,
    // BIGINT columns come back from Postgres as strings.
    workflow_version: Number(run.workflow_version),
    steps: run.steps,
    checkpoints: run.checkpoints ?? {},
    requested_by: run.requested_by,
    created_at: new Date(run.created_at).toISOString(),
    updated_at: new Date(run.updated_at).toISOString(),
    nodes: run.workflow.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label || NODE_SPEC_INDEX[n.type]?.label || n.type })),
  };
}

/**
 * What the run ended as. Starting a new run on a subject marks the earlier one
 * "superseded", which hides how it finished, so that is read back from its steps.
 */
export type RunOutcome = Exclude<RunStatus, "superseded"> | "stopped";

export function runOutcome(run: Pick<RunSummary, "status" | "steps" | "nodes">): RunOutcome {
  if (run.status !== "superseded") return run.status;
  const draft = run.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  const steps = Object.values(run.steps);
  if (draft && run.steps[draft.id]?.status === "done") return "draft";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "waiting")) return "awaiting_review";
  // Replaced before it finished.
  return "stopped";
}

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  running: "Running",
  awaiting_review: "Awaiting review",
  paused: "Paused",
  draft: "Result saved",
  failed: "Failed",
  stopped: "Stopped",
};

const ms = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

/** How long a step ran, in ms, or null when it did not run to an end. */
export function stepDuration(s: StepState | undefined): number | null {
  const d = ms(s?.finishedAt) - ms(s?.startedAt);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** Start to the last recorded change, in ms; null while the run is still going. Includes time waiting at checkpoints. */
export function runDuration(run: Pick<RunSummary, "status" | "created_at" | "updated_at">): number | null {
  if (run.status === "running") return null;
  const d = ms(run.updated_at) - ms(run.created_at);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

export function formatDuration(d: number | null): string {
  if (d === null) return "—";
  if (d < 1000) return `${Math.round(d)} ms`;
  if (d < 60_000) return `${(d / 1000).toFixed(d < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(d / 60_000);
  const s = Math.round((d % 60_000) / 1000);
  return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One line of a run's timeline. */
export type TimelineEntry = { at: string; kind: "run" | "step" | "checkpoint"; nodeId?: string; title: string; detail?: string; status: "ok" | "failed" | "skipped" | "waiting" | "running" | "info" };

/** The run as a list of events, oldest first: started, each step, checkpoint decisions, and how it ended. */
export function runTimeline(run: RunSummary, now = Date.now()): TimelineEntry[] {
  const out: TimelineEntry[] = [{ at: run.created_at, kind: "run", title: "Run started", detail: `by ${run.requested_by} · ${workflowLabel(run)}`, status: "info" }];
  const label = new Map(run.nodes.map((n) => [n.id, n.label]));
  for (const n of run.nodes) {
    const s = run.steps[n.id];
    if (!s || s.status === "pending") continue;
    const d = stepDuration(s);
    const took = d !== null ? ` in ${formatDuration(d)}` : s.status === "running" && s.startedAt ? ` · ${formatDuration(now - ms(s.startedAt))} so far` : "";
    const status = s.status === "done" ? "ok" : s.status;
    const verb = { done: "finished", failed: "failed", skipped: "skipped", waiting: "is waiting for review", running: "is running" }[s.status];
    out.push({ at: s.finishedAt ?? s.startedAt ?? run.created_at, kind: "step", nodeId: n.id, title: `${n.label} ${verb}${took}`, detail: s.error ?? s.note, status });
  }
  for (const [nodeId, c] of Object.entries(run.checkpoints ?? {})) {
    out.push({
      at: c.at,
      kind: "checkpoint",
      nodeId,
      title: `${c.by} continued ${label.get(nodeId) ?? nodeId}`,
      detail: [c.excluded.length ? `left out ${c.excluded.length} item(s)` : "", c.note ? `“${c.note}”` : ""].filter(Boolean).join(" · ") || undefined,
      status: "info",
    });
  }
  const outcome = runOutcome(run);
  if (outcome !== "running") {
    const failed = run.nodes.filter((n) => run.steps[n.id]?.status === "failed").length;
    const skipped = run.nodes.filter((n) => run.steps[n.id]?.status === "skipped").length;
    out.push({
      at: run.updated_at,
      kind: "run",
      title: `Run ${outcome === "draft" ? "finished: result saved" : outcome === "failed" ? "finished without a result" : OUTCOME_LABEL[outcome].toLowerCase()}`,
      detail: [`total ${formatDuration(runDuration(run))}`, failed ? `${failed} step(s) failed` : "", skipped ? `${skipped} skipped` : "", run.status === "superseded" ? "replaced by a later run" : ""].filter(Boolean).join(" · "),
      status: outcome === "draft" ? "ok" : outcome === "failed" ? "failed" : outcome === "awaiting_review" ? "waiting" : "info",
    });
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at));
}

export type StepStats = { nodeId: string; label: string; type: string; runs: number; failed: number; min: number; max: number; avg: number };
/** "Name · v3", or "Name · built-in default" for version 0. */
export const workflowLabel = (r: Pick<RunSummary, "workflow_name" | "workflow_version">) =>
  `${r.workflow_name} · ${r.workflow_version ? `v${r.workflow_version}` : "built-in default"}`;

/** Identifies one version of one workflow, for grouping and filtering runs. */
export const versionKey = (r: Pick<RunSummary, "workflow_id" | "workflow_version">) => `${r.workflow_id}@${r.workflow_version}`;

export type VersionStats = { key: string; label: string; workflowId: string; version: number; runs: number; results: number; failed: number; avgRun: number | null; steps: StepStats[] };

export type RunsOverview = {
  total: number;
  byOutcome: Record<RunOutcome, number>;
  /** The most common step errors, most frequent first. */
  topErrors: Array<{ label: string; error: string; count: number }>;
  /** Newest version first; steps slowest (by average) first. */
  versions: VersionStats[];
};

export function summarizeRuns(runs: RunSummary[]): RunsOverview {
  const byOutcome = Object.fromEntries(Object.keys(OUTCOME_LABEL).map((k) => [k, 0])) as Record<RunOutcome, number>;
  const errors = new Map<string, { label: string; error: string; count: number }>();
  type VersionAcc = { runs: RunSummary[]; steps: Map<string, StepStats & { total: number; timed: number }> };
  type VersionGroup = VersionAcc & { label: string; workflowId: string; version: number };
  const versions = new Map<string, VersionGroup>();

  for (const run of runs) {
    byOutcome[runOutcome(run)]++;
    const v: VersionGroup = versions.get(versionKey(run)) ?? { runs: [], steps: new Map(), label: workflowLabel(run), workflowId: run.workflow_id, version: run.workflow_version };
    versions.set(versionKey(run), v);
    v.runs.push(run);
    for (const n of run.nodes) {
      const s = run.steps[n.id];
      if (!s || s.status === "pending" || s.status === "skipped") continue;
      // Steps are keyed by node id; a node renamed in a later version keeps its id.
      const st = v.steps.get(n.id) ?? { nodeId: n.id, label: n.label, type: n.type, runs: 0, failed: 0, min: Infinity, max: 0, avg: 0, total: 0, timed: 0 };
      v.steps.set(n.id, st);
      st.runs++;
      if (s.status === "failed") {
        st.failed++;
        if (s.error) {
          const key = `${n.label}\u0000${s.error}`;
          const e = errors.get(key) ?? { label: n.label, error: s.error, count: 0 };
          e.count++;
          errors.set(key, e);
        }
      }
      // Checkpoints measure how long a person took, not the workflow.
      const d = n.type === CHECKPOINT_NODE_TYPE ? null : stepDuration(s);
      if (d !== null) {
        st.timed++;
        st.total += d;
        st.min = Math.min(st.min, d);
        st.max = Math.max(st.max, d);
      }
    }
  }

  return {
    total: runs.length,
    byOutcome,
    topErrors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    // By workflow, newest version first within each.
    versions: [...versions.entries()]
      .sort(([, a], [, b]) => a.label.split(" · ")[0].localeCompare(b.label.split(" · ")[0]) || b.version - a.version)
      .map(([key, v]) => {
        const durations = v.runs.map(runDuration).filter((d): d is number => d !== null);
        return {
          key,
          label: v.label,
          workflowId: v.workflowId,
          version: v.version,
          runs: v.runs.length,
          results: v.runs.filter((r) => runOutcome(r) === "draft").length,
          failed: v.runs.filter((r) => runOutcome(r) === "failed").length,
          avgRun: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
          steps: [...v.steps.values()]
            .filter((s) => s.timed > 0)
            .map(({ total, timed, ...s }) => ({ ...s, avg: total / timed }))
            .sort((a, b) => b.avg - a.avg),
        };
      }),
  };
}
