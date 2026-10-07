// Persistence and audit for workflows: saved workflow versions and the runs made
// with them. A run's result is what its Save output node recorded; it is a draft
// for the author to use, and nothing here changes a document by itself.
//
// Without POSTGRES_URL (local development) both live in process memory, so the
// editor and runs work locally but do not survive a restart.
//
// Table names (determination_workflow, agent_determination_run) and the unused
// proposals/agreement/synthesis columns are inherited from the app Sasha was
// copied from. They stay as-is in Phase 0; the rename is planned for Phase 6
// (docs/PLAN.md §4.3).

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { toRunSummary, type RunSummary } from "@/lib/workflow/run-stats";
import { WorkflowGraph } from "@/lib/workflow/types";
import { defaultAuditSink, type Auth } from "@/lib/ontology/governance";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { OUTPUT_NODE_TYPE } from "./registry";

const hasDb = () => !!process.env.POSTGRES_URL;

/** Permission strings for running workflows and reading run history (see src/lib/ontology/permissions.ts). */
export const RUN_PERMISSION = "workflow:run";
export const RUN_READ_PERMISSION = "workflow:read";

// --- Workflows and their versions --------------------------------------------

/** The built-in workflow every database starts with; runs and versions without a workflow id belong to it. */
export const LEGACY_WORKFLOW_ID = "default";
const LEGACY_WORKFLOW_NAME = "Default workflow";

export const WORKFLOW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflow (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `INSERT INTO workflow (id, name, created_by) VALUES ('${LEGACY_WORKFLOW_ID}', '${LEGACY_WORKFLOW_NAME}', 'system') ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS determination_workflow (
     id BIGSERIAL PRIMARY KEY, definition JSONB NOT NULL, note TEXT NOT NULL DEFAULT '',
     created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `ALTER TABLE determination_workflow ADD COLUMN IF NOT EXISTS workflow_id TEXT NOT NULL DEFAULT '${LEGACY_WORKFLOW_ID}'`,
  `ALTER TABLE determination_workflow ADD COLUMN IF NOT EXISTS version INTEGER`,
  // Number the versions saved before per-workflow numbering, in the order they were saved.
  `UPDATE determination_workflow d SET version = r.n
     FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY id) AS n FROM determination_workflow) r
    WHERE d.id = r.id AND d.version IS NULL`,
  `CREATE INDEX IF NOT EXISTS determination_workflow_version_idx ON determination_workflow (workflow_id, version DESC)`,
  `CREATE TABLE IF NOT EXISTS app_setting (
     key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_by TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS agent_determination_run (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
     workflow_version BIGINT NOT NULL DEFAULT 0, workflow JSONB, steps JSONB, raw JSONB,
     proposals JSONB, agreement JSONB, synthesis JSONB, requested_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `ALTER TABLE agent_determination_run ADD COLUMN IF NOT EXISTS workflow_id TEXT`,
  `ALTER TABLE agent_determination_run ADD COLUMN IF NOT EXISTS workflow_name TEXT`,
  `ALTER TABLE agent_determination_run ADD COLUMN IF NOT EXISTS outputs JSONB`,
  `ALTER TABLE agent_determination_run ADD COLUMN IF NOT EXISTS checkpoints JSONB`,
];

const schema = () => ensureSchema("workflows", WORKFLOW_SCHEMA);

/** A named workflow and where its version history stands. */
export type WorkflowInfo = { id: string; name: string; created_by: string; created_at: string; latestVersion: number; updated_at: string };
/** One saved version of a workflow (version 0 is the built-in default, used until a version is saved). */
export type SavedWorkflow = { workflow_id: string; name: string; version: number; definition: WorkflowGraph; note: string; created_by: string; created_at: string };
export type VersionInfo = Omit<SavedWorkflow, "definition" | "workflow_id" | "name">;

const iso = (v: unknown) => new Date(v as string).toISOString();
const builtIn = (workflowId: string, name: string): SavedWorkflow => ({
  workflow_id: workflowId,
  name,
  version: 0,
  definition: defaultWorkflowGraph(),
  note: "Built-in default",
  created_by: "system",
  created_at: new Date(0).toISOString(),
});

// Without a database: workflows, versions and the default in process memory.
const memory = {
  workflows: new Map<string, Omit<WorkflowInfo, "latestVersion" | "updated_at">>([
    [LEGACY_WORKFLOW_ID, { id: LEGACY_WORKFLOW_ID, name: LEGACY_WORKFLOW_NAME, created_by: "system", created_at: new Date(0).toISOString() }],
  ]),
  versions: new Map<string, SavedWorkflow[]>(),
  defaultId: LEGACY_WORKFLOW_ID,
};

export async function listWorkflows(): Promise<WorkflowInfo[]> {
  if (!hasDb()) {
    return [...memory.workflows.values()].map((w) => {
      const last = memory.versions.get(w.id)?.at(-1);
      return { ...w, latestVersion: last?.version ?? 0, updated_at: last?.created_at ?? w.created_at };
    });
  }
  await schema();
  const { rows } = await sql`
    SELECT w.id, w.name, w.created_by, w.created_at, COALESCE(MAX(d.version), 0) AS latest, COALESCE(MAX(d.created_at), w.created_at) AS updated_at
      FROM workflow w LEFT JOIN determination_workflow d ON d.workflow_id = w.id
     GROUP BY w.id ORDER BY w.created_at, w.name`;
  return rows.map((r) => ({ id: r.id, name: r.name, created_by: r.created_by, created_at: iso(r.created_at), latestVersion: Number(r.latest), updated_at: iso(r.updated_at) }));
}

async function workflowName(id: string): Promise<string | null> {
  if (!hasDb()) return memory.workflows.get(id)?.name ?? null;
  await schema();
  const { rows } = await sql`SELECT name FROM workflow WHERE id = ${id}`;
  return rows[0]?.name ?? null;
}

/**
 * A workflow's version: the newest when `version` is omitted, the built-in
 * default when none has been saved (or for version 0). Null for an unknown
 * workflow or version.
 */
export async function getWorkflow(workflowId: string, version?: number): Promise<SavedWorkflow | null> {
  const name = await workflowName(workflowId);
  if (name === null) return null;
  if (version === 0) return builtIn(workflowId, name);
  let row: Omit<SavedWorkflow, "workflow_id" | "name"> | undefined;
  if (!hasDb()) {
    const all = memory.versions.get(workflowId) ?? [];
    row = version === undefined ? all.at(-1) : all.find((v) => v.version === version);
  } else {
    const { rows } =
      version === undefined
        ? await sql`SELECT version, definition, note, created_by, created_at FROM determination_workflow WHERE workflow_id = ${workflowId} ORDER BY version DESC LIMIT 1`
        : await sql`SELECT version, definition, note, created_by, created_at FROM determination_workflow WHERE workflow_id = ${workflowId} AND version = ${version}`;
    if (rows[0]) row = { version: Number(rows[0].version), definition: rows[0].definition, note: rows[0].note, created_by: rows[0].created_by, created_at: iso(rows[0].created_at) };
  }
  if (!row) return version === undefined ? builtIn(workflowId, name) : null;
  // A version saved in an older format falls back to the default rather than breaking every run.
  const parsed = WorkflowGraph.safeParse(row.definition);
  return { ...row, workflow_id: workflowId, name, definition: parsed.success ? parsed.data : defaultWorkflowGraph() };
}

/** A workflow's saved versions, newest first. */
export async function listVersions(workflowId: string): Promise<VersionInfo[]> {
  if (!hasDb()) return [...(memory.versions.get(workflowId) ?? [])].reverse().map(({ version, note, created_by, created_at }) => ({ version, note, created_by, created_at }));
  await schema();
  const { rows } = await sql`SELECT version, note, created_by, created_at FROM determination_workflow WHERE workflow_id = ${workflowId} ORDER BY version DESC`;
  return rows.map((r) => ({ version: Number(r.version), note: r.note, created_by: r.created_by, created_at: iso(r.created_at) }));
}

/** Save a new version of a workflow; it becomes the version that runs by default. */
export async function saveWorkflow(workflowId: string, definition: WorkflowGraph, note: string, auth: Auth): Promise<SavedWorkflow> {
  const name = await workflowName(workflowId);
  if (name === null) throw new Error(`workflow not found: ${workflowId}`);
  let saved: SavedWorkflow;
  if (hasDb()) {
    // The next number is taken in the insert itself, so two saves can't share one.
    const { rows } = await sql`
      INSERT INTO determination_workflow (workflow_id, version, definition, note, created_by)
      SELECT ${workflowId}, COALESCE(MAX(version), 0) + 1, ${JSON.stringify(definition)}::jsonb, ${note}, ${auth.agent}
        FROM determination_workflow WHERE workflow_id = ${workflowId}
      RETURNING version, created_at`;
    saved = { workflow_id: workflowId, name, version: Number(rows[0].version), definition, note, created_by: auth.agent, created_at: iso(rows[0].created_at) };
  } else {
    const all = memory.versions.get(workflowId) ?? [];
    saved = { workflow_id: workflowId, name, version: all.length + 1, definition, note, created_by: auth.agent, created_at: new Date().toISOString() };
    memory.versions.set(workflowId, [...all, saved]);
  }
  await defaultAuditSink().write({
    agent: auth.agent,
    action: "save_workflow_version",
    args: { workflow_id: workflowId, note },
    result: { version: saved.version, nodes: definition.nodes.length },
    allowed: true,
  });
  return saved;
}

/** Create a named workflow, starting from `definition` as its version 1. */
export async function createWorkflow(name: string, definition: WorkflowGraph, auth: Auth): Promise<WorkflowInfo> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workflow";
  const id = `${slug}-${randomUUID().slice(0, 6)}`;
  if (hasDb()) {
    await schema();
    await sql`INSERT INTO workflow (id, name, created_by) VALUES (${id}, ${name}, ${auth.agent})`;
  } else {
    memory.workflows.set(id, { id, name, created_by: auth.agent, created_at: new Date().toISOString() });
  }
  await defaultAuditSink().write({ agent: auth.agent, action: "create_workflow", args: { name }, result: { id }, allowed: true });
  const first = await saveWorkflow(id, definition, "Created", auth);
  return { id, name, created_by: auth.agent, created_at: first.created_at, latestVersion: first.version, updated_at: first.created_at };
}

export async function renameWorkflow(id: string, name: string, auth: Auth): Promise<boolean> {
  if (!hasDb()) {
    const w = memory.workflows.get(id);
    if (w) w.name = name;
    return !!w;
  }
  await schema();
  const { rowCount } = await sql`UPDATE workflow SET name = ${name} WHERE id = ${id}`;
  await defaultAuditSink().write({ agent: auth.agent, action: "rename_workflow", args: { id, name }, result: { ok: !!rowCount }, allowed: true });
  return !!rowCount;
}

/** The workflow new uploads run unless someone picks another; the oldest one when the setting is unset or stale. */
export async function getDefaultWorkflowId(): Promise<string> {
  const workflows = await listWorkflows();
  let id: string | undefined;
  if (!hasDb()) id = memory.defaultId;
  else {
    const { rows } = await sql`SELECT value FROM app_setting WHERE key = 'default_workflow'`;
    id = rows[0]?.value?.id;
  }
  return workflows.some((w) => w.id === id) ? id! : (workflows[0]?.id ?? LEGACY_WORKFLOW_ID);
}

export async function setDefaultWorkflowId(id: string, auth: Auth): Promise<boolean> {
  if ((await workflowName(id)) === null) return false;
  if (!hasDb()) memory.defaultId = id;
  else
    await sql`INSERT INTO app_setting (key, value, updated_by) VALUES ('default_workflow', ${JSON.stringify({ id })}::jsonb, ${auth.agent})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await defaultAuditSink().write({ agent: auth.agent, action: "set_default_workflow", args: { id }, result: { ok: true }, allowed: true });
  return true;
}

/** The newest version of a workflow, or of the default workflow when none is named. */
export async function activeWorkflow(workflowId?: string): Promise<SavedWorkflow> {
  const id = workflowId ?? (await getDefaultWorkflowId());
  return (await getWorkflow(id)) ?? builtIn(id, LEGACY_WORKFLOW_NAME);
}

// --- Runs ---------------------------------------------------------------------

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "waiting";
export type StepState = { status: StepStatus; startedAt?: string; finishedAt?: string; error?: string; note?: string };

/**
 * running: executing now. awaiting_review: stopped at a human checkpoint.
 * paused: stopped at the time budget, continue to resume. draft: finished, with
 * a result saved. failed: finished without one. superseded: a later run on the
 * same subject replaced it.
 */
export type RunStatus = "running" | "awaiting_review" | "paused" | "draft" | "failed" | "superseded";

export type CheckpointDecision = { excluded: number[]; note: string; by: string; at: string };

export type WorkflowRun = {
  id: string;
  /** The run's subject: for now, the upload group whose source documents it reads. */
  group_id: string;
  status: RunStatus;
  /** Which workflow ran, and which of its versions. */
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  /** The graph the run used, so a later edit cannot change how a past run reads. */
  workflow: WorkflowGraph;
  /** Per node. */
  steps: Record<string, StepState>;
  /** Per node, per output port. The Save output node's `result` is the run's result. */
  outputs: Record<string, Record<string, unknown>>;
  /** People's decisions at human checkpoints, per node. */
  checkpoints: Record<string, CheckpointDecision>;
  /** Model replies that failed validation, per node. */
  raw: Record<string, string>;
  requested_by: string;
  created_at: string;
  updated_at: string;
};

const memoryRuns = new Map<string, WorkflowRun>();

export async function createRun(groupId: string, workflow: SavedWorkflow, auth: Auth): Promise<WorkflowRun> {
  const now = new Date().toISOString();
  const run: WorkflowRun = {
    id: randomUUID(),
    group_id: groupId,
    status: "running",
    workflow_id: workflow.workflow_id,
    workflow_name: workflow.name,
    workflow_version: workflow.version,
    workflow: workflow.definition,
    steps: Object.fromEntries(workflow.definition.nodes.map((n) => [n.id, { status: "pending" as const }])),
    outputs: {},
    checkpoints: {},
    raw: {},
    requested_by: auth.agent,
    created_at: now,
    updated_at: now,
  };
  if (hasDb()) {
    await schema();
    await sql`UPDATE agent_determination_run SET status = 'superseded', updated_at = now()
              WHERE group_id = ${groupId} AND status IN ('running', 'awaiting_review', 'paused', 'draft')`;
    await sql`INSERT INTO agent_determination_run (id, group_id, status, workflow_id, workflow_name, workflow_version, workflow, steps, outputs, checkpoints, raw, requested_by)
              VALUES (${run.id}, ${groupId}, 'running', ${run.workflow_id}, ${run.workflow_name}, ${run.workflow_version}, ${JSON.stringify(run.workflow)}::jsonb,
                      ${JSON.stringify(run.steps)}::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${auth.agent})`;
  } else {
    for (const r of memoryRuns.values()) if (r.group_id === groupId && r.status !== "failed" && r.status !== "superseded") r.status = "superseded";
    memoryRuns.set(run.id, run);
  }
  await defaultAuditSink().write({ agent: auth.agent, action: "start_workflow_run", args: { group_id: groupId, workflow_id: workflow.workflow_id, workflow_version: workflow.version }, result: { runId: run.id }, allowed: true, groupId });
  return run;
}

/** Persist the run's mutable state. `outputs` should already have large references stripped. */
export async function saveRun(run: WorkflowRun, outputs: WorkflowRun["outputs"]): Promise<void> {
  run.updated_at = new Date().toISOString();
  if (!hasDb()) return;
  await sql`UPDATE agent_determination_run
            SET status = ${run.status}, steps = ${JSON.stringify(run.steps)}::jsonb, outputs = ${JSON.stringify(outputs)}::jsonb,
                checkpoints = ${JSON.stringify(run.checkpoints)}::jsonb, raw = ${JSON.stringify(run.raw)}::jsonb, updated_at = now()
            WHERE id = ${run.id}`;
}

/**
 * A running run with no progress for this long is treated as dead. Runs execute
 * in the request's after() under a 300-second limit (the engine pauses itself
 * well before that), so a "running" row this old means the function was stopped
 * before it could record anything.
 */
export const STALE_RUN_MS = 6 * 60 * 1000;

/** Report a run that stopped responding as failed, without rewriting the stored row. */
export function withStaleCheck(run: WorkflowRun | null, now = Date.now()): WorkflowRun | null {
  if (!run || run.status !== "running" || now - new Date(run.updated_at).getTime() < STALE_RUN_MS) return run;
  return {
    ...run,
    status: "failed",
    steps: Object.fromEntries(
      Object.entries(run.steps).map(([k, s]) => [k, s.status === "running" || s.status === "pending" ? { ...s, status: "failed" as const, error: "stopped responding; run again" } : s]),
    ),
  };
}

function normalize(row: WorkflowRun | undefined): WorkflowRun | null {
  if (!row) return null;
  // Rows from the earlier, fixed-pipeline version of this feature.
  const parsed = WorkflowGraph.safeParse(row.workflow);
  if (!parsed.success) return null;
  return {
    ...row,
    // Runs from before named workflows belong to the one workflow there was.
    workflow_id: row.workflow_id ?? LEGACY_WORKFLOW_ID,
    workflow_name: row.workflow_name ?? LEGACY_WORKFLOW_NAME,
    workflow_version: Number(row.workflow_version),
    workflow: parsed.data,
    outputs: row.outputs ?? {},
    checkpoints: row.checkpoints ?? {},
    raw: row.raw ?? {},
    steps: row.steps ?? {},
  };
}

export async function getRun(runId: string): Promise<WorkflowRun | null> {
  if (!hasDb()) return withStaleCheck(memoryRuns.get(runId) ?? null);
  const { rows } = await sql<WorkflowRun>`SELECT * FROM agent_determination_run WHERE id = ${runId}`;
  return withStaleCheck(normalize(rows[0]));
}

export async function latestRun(groupId: string): Promise<WorkflowRun | null> {
  if (!hasDb()) return withStaleCheck([...memoryRuns.values()].filter((r) => r.group_id === groupId).at(-1) ?? null);
  const { rows } = await sql<WorkflowRun>`SELECT * FROM agent_determination_run WHERE group_id = ${groupId} ORDER BY created_at DESC LIMIT 1`;
  return withStaleCheck(normalize(rows[0]));
}

/** The newest runs across all subjects, without their outputs, for the Run log and Overview. */
export async function listRunSummaries(limit: number): Promise<RunSummary[]> {
  if (!hasDb()) {
    return [...memoryRuns.values()]
      .reverse()
      .slice(0, limit)
      .map((r) => toRunSummary(withStaleCheck(r)!));
  }
  // Outputs can be large, so they are left out.
  const { rows } = await sql<WorkflowRun>`
    SELECT id, group_id, status, workflow_id, workflow_name, workflow_version, workflow, steps, checkpoints, requested_by, created_at, updated_at
    FROM agent_determination_run ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.flatMap((row) => {
    const run = withStaleCheck(normalize({ ...row, outputs: {}, raw: {} }));
    return run ? [toRunSummary(run)] : [];
  });
}

/**
 * The subject's newest runs, newest first, for reading back what they produced
 * (a run in progress or one that failed may have nothing yet, so callers look
 * past it).
 */
export async function recentRuns(groupId: string, limit = 5): Promise<WorkflowRun[]> {
  if (!hasDb()) return [...memoryRuns.values()].filter((r) => r.group_id === groupId).reverse().slice(0, limit);
  const { rows } = await sql<WorkflowRun>`SELECT * FROM agent_determination_run WHERE group_id = ${groupId} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => normalize(r)).filter((r): r is WorkflowRun => !!r);
}

/** A run still in progress: executing, stopped at a checkpoint, or paused at the time budget. */
export type ActiveRun = { id: string; status: "running" | "awaiting_review" | "paused" };
const ACTIVE: RunStatus[] = ["running", "awaiting_review", "paused"];

/** Each subject's latest run, for the subjects whose latest run is still in progress. */
export async function activeRunsFor(groupIds: string[]): Promise<Record<string, ActiveRun>> {
  const latest: WorkflowRun[] = [];
  if (!groupIds.length) return {};
  if (!hasDb()) {
    for (const id of groupIds) {
      const run = [...memoryRuns.values()].filter((r) => r.group_id === id).at(-1);
      if (run) latest.push(run);
    }
  } else {
    // Only the columns the stale check reads; steps and outputs can be large.
    const { rows } = await sql.query(
      `SELECT DISTINCT ON (group_id) id, group_id, status, updated_at FROM agent_determination_run
        WHERE group_id = ANY($1) ORDER BY group_id, created_at DESC`,
      [groupIds],
    );
    latest.push(...(rows as WorkflowRun[]).map((r) => ({ ...r, steps: {}, updated_at: new Date(r.updated_at).toISOString() })));
  }
  const out: Record<string, ActiveRun> = {};
  for (const r of latest) {
    const run = withStaleCheck(r)!;
    if (ACTIVE.includes(run.status)) out[run.group_id] = { id: run.id, status: run.status as ActiveRun["status"] };
  }
  return out;
}

/** What the run's Save output node recorded, or null when it has not run. */
export function runResult(run: Pick<WorkflowRun, "workflow" | "outputs">): string | null {
  const node = run.workflow.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  const result = node ? run.outputs[node.id]?.result : undefined;
  return typeof result === "string" ? result : null;
}

export type RunAuditEntry = { ts: string; agent: string; action: string; allowed: boolean; note: string; result: unknown };

/**
 * The audit log's entries for one run, oldest first. Empty without a database (they go to the console).
 * The start entry records the run's ID in its result, the rest in their args.
 */
export async function runAuditTrail(runId: string): Promise<RunAuditEntry[]> {
  if (!hasDb()) return [];
  const { rows } = await sql`SELECT ts, agent, action, allowed, note, result FROM audit_log WHERE args->>'runId' = ${runId} OR result->>'runId' = ${runId} ORDER BY ts ASC LIMIT 200`;
  return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), agent: r.agent, action: r.action, allowed: r.allowed, note: r.note, result: r.result }));
}

/**
 * Atomically move a run from `from` to running, so two clicks on Continue
 * cannot start it twice. Returns false when the run was not in `from`.
 */
export async function claimRun(run: WorkflowRun, from: RunStatus[]): Promise<boolean> {
  if (!from.includes(run.status)) return false;
  if (hasDb()) {
    // sql.query: the tagged template only accepts primitives, and this binds an array.
    const { rows } = await sql.query(
      `UPDATE agent_determination_run SET status = 'running', updated_at = now() WHERE id = $1 AND status = ANY($2) RETURNING id`,
      [run.id, from],
    );
    if (!rows.length) return false;
  }
  run.status = "running";
  run.updated_at = new Date().toISOString();
  return true;
}

export async function auditRun(run: WorkflowRun, action: string, result: unknown, note?: string, agent = "workflow_engine"): Promise<void> {
  await defaultAuditSink().write({ agent, action, args: { group_id: run.group_id, runId: run.id }, result, allowed: true, note, groupId: run.group_id });
}
