// Persistence and audit for workflows: a team's own workflows and their saved
// versions, the built-in workflows (read-only, compiled from the catalog), the
// team's canvas default, and runs on documents. Every function takes the team
// first; nothing is shared across teams. A run's outcome stays advisory until
// its checkpoint; nothing here changes a document by itself (proposed changes
// are applied by the open editor).
//
// Without POSTGRES_URL (local development, tests) everything lives in process
// memory (processMemory) and does not survive a restart.
//
// Rows from before Phase 6 (the organizer's runs on upload groups) keep team_id
// '' and are seen by no team; normalize() still reads their shapes (old node
// types, "draft" status, checkpoint decisions without a verdict).

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { builtInId, builtInWorkflow, builtInWorkflows, parseBuiltInId } from "@/catalog/workflows";
import { onMemoryStoreReset } from "@/lib/documents/store";
import { AUDIT_LOG_SCHEMA } from "@/lib/ontology/audit-schema";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { defaultAuditSink, type Auth } from "@/lib/ontology/governance";
import { processMemory } from "@/lib/process-memory";
import { compileWorkflow } from "./compile";
import {
  ACTIVE_RUN_STATUSES,
  MAX_RUN_HISTORY,
  runBrief,
  type ChangeResult,
  type CheckpointDecision,
  type FindingResponse,
  type ProposedChange,
  type RunBrief,
  type RunParams,
  type RunStatus,
  type WorkflowRunRecord,
  type WorkflowRunView,
} from "./contract";
import { defaultWorkflowGraph } from "./default-graph";
import { LEGACY_NODE_TYPES, NODE_SPEC_INDEX, OUTPUT_NODE_TYPE } from "./registry";
import { toRunSummary, type RunSummary } from "./run-stats";
import { WORKFLOW_SCHEMA } from "./schema";
import { WorkflowGraph } from "./types";

export type { StepState, StepStatus, RunStatus } from "./contract";

const hasDb = () => !!process.env.POSTGRES_URL;

/** Permission strings for running workflows and reading run history (see src/lib/ontology/permissions.ts). */
export const RUN_PERMISSION = "workflow:run";
export const RUN_READ_PERMISSION = "workflow:read";

// The tables live in schema.ts (Phase 6 renames: workflow_version, workflow_run).
export { WORKFLOW_SCHEMA };

/**
 * Phase 8 (PLAN §6.11): a team workflow may be bound to one document type
 * (a workflow learned with its type). Unbound workflows (applies_to NULL) are
 * offered on every document, a bound one only on documents of its type
 * (availability.ts). Kept in step with db/schema.sql; spread into the setup route.
 */
export const WORKFLOW_BINDING_SCHEMA = [
  `ALTER TABLE workflow ADD COLUMN IF NOT EXISTS applies_to TEXT`,
  `CREATE INDEX IF NOT EXISTS workflow_applies_idx ON workflow (team_id, applies_to)`,
];

const schema = () => ensureSchema("workflows", [...WORKFLOW_SCHEMA, ...WORKFLOW_BINDING_SCHEMA]);

/** A workflow the canvas can open: one of the team's, or a built-in (read-only). */
export type WorkflowInfo = {
  id: string;
  name: string;
  /** The built-in or team workflow this one was copied from. */
  based_on: string | null;
  /** The document type a team workflow is bound to (offered only on documents of that type); null for every document. */
  applies_to: string | null;
  builtIn: boolean;
  created_by: string;
  created_at: string;
  latestVersion: number;
  updated_at: string;
};
/** One version of a workflow (version 0 of a team workflow is the starting graph, used until a version is saved). */
export type SavedWorkflow = {
  workflow_id: string;
  name: string;
  version: number;
  graph: WorkflowGraph;
  note: string;
  created_by: string;
  created_at: string;
  /** Built-ins: shown, run and copied, never saved over. */
  readOnly: boolean;
  based_on: string | null;
};
export type VersionInfo = Pick<SavedWorkflow, "version" | "note" | "created_by" | "created_at">;

/** @deprecated The run record is WorkflowRunRecord (contract.ts); kept so the canvas's type imports resolve. */
export type WorkflowRun = WorkflowRunRecord;

/** The error saveWorkflow throws for a built-in id. */
export class ReadOnlyWorkflowError extends Error {
  constructor() {
    super("Built-in workflows can't be changed; copy it first.");
  }
}

const iso = (v: unknown) => new Date(v as string).toISOString();
const EPOCH = new Date(0).toISOString();
const clone = <T>(v: T): T => structuredClone(v);

// --- Reading old shapes -----------------------------------------------------------

/** The organizer's source.documents outputs, by the sources.read output that replaces each. */
const LEGACY_SOURCE_PORTS: Record<string, string> = { combined: "text", documents: "passages", names: "sources" };

/**
 * A saved graph in today's node set: renamed node types (LEGACY_NODE_TYPES),
 * output.save's `text` input as the outcome's `summary`, source.documents'
 * outputs as sources.read's, and the new types' defaults under the old settings.
 */
export function normalizeGraph(raw: unknown): WorkflowGraph | null {
  const parsed = WorkflowGraph.safeParse(raw);
  if (!parsed.success) return null;
  const g = parsed.data;
  const legacy = new Map(g.nodes.filter((n) => LEGACY_NODE_TYPES[n.type]).map((n) => [n.id, n.type]));
  if (!legacy.size) return g;
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const type = LEGACY_NODE_TYPES[n.type];
      if (!type) return n;
      const defaults = NODE_SPEC_INDEX[type]?.defaults() ?? {};
      // The outcome's settings are new; the old Save output had none worth keeping.
      const config = type === OUTPUT_NODE_TYPE ? defaults : { ...defaults, ...n.config };
      return { ...n, type, config };
    }),
    edges: g.edges.map((e) => {
      const from = legacy.get(e.source);
      const to = legacy.get(e.target);
      let next = e;
      if (from === "source.documents" && LEGACY_SOURCE_PORTS[e.sourceHandle]) next = { ...next, sourceHandle: LEGACY_SOURCE_PORTS[e.sourceHandle] };
      if (from === "output.save" && e.sourceHandle === "result") next = { ...next, sourceHandle: "outcome" };
      if (to === "output.save" && e.targetHandle === "text") next = { ...next, targetHandle: "summary" };
      return next;
    }),
  };
}

/** A decision from before Phase 6 ({excluded, note, by, at}) reads as an approval. */
function normalizeDecision(raw: unknown): CheckpointDecision {
  const d = (raw ?? {}) as Partial<CheckpointDecision>;
  return {
    verdict: d.verdict ?? "approve",
    note: d.note ?? "",
    by: d.by ?? "",
    at: d.at ?? EPOCH,
    role: d.role ?? "",
    excluded: Array.isArray(d.excluded) ? d.excluded : [],
    edits: d.edits ?? null,
  };
}

/** A stored run in today's shape, or null for a row whose graph can't be read. */
export function normalizeRun(row: Record<string, unknown> | undefined | null): WorkflowRunRecord | null {
  if (!row) return null;
  const graph = normalizeGraph(row.graph ?? row.workflow);
  if (!graph) return null;
  const status = row.status === "draft" ? "complete" : (row.status as RunStatus);
  const checkpoints = Object.fromEntries(Object.entries((row.checkpoints ?? {}) as Record<string, unknown>).map(([k, v]) => [k, normalizeDecision(v)]));
  return {
    id: String(row.id),
    team_id: String(row.team_id ?? ""),
    document_id: row.document_id == null ? "" : String(row.document_id),
    status,
    pause_reason: (row.pause_reason as WorkflowRunRecord["pause_reason"]) ?? null,
    workflow_id: String(row.workflow_id ?? ""),
    workflow_name: String(row.workflow_name ?? ""),
    // BIGINT columns come back from Postgres as strings.
    workflow_version: Number(row.workflow_version ?? 0),
    graph,
    params: (row.params as RunParams) ?? {},
    steps: (row.steps as WorkflowRunRecord["steps"]) ?? {},
    outputs: (row.outputs as WorkflowRunRecord["outputs"]) ?? {},
    checkpoints,
    outcome: (row.outcome as WorkflowRunRecord["outcome"]) ?? null,
    changes: (row.changes as WorkflowRunRecord["changes"]) ?? {},
    responses: (row.responses as WorkflowRunRecord["responses"]) ?? {},
    raw: (row.raw as WorkflowRunRecord["raw"]) ?? {},
    requested_by: String(row.requested_by ?? ""),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

// --- In-memory fallback -------------------------------------------------------------

type WorkflowRow = { id: string; team_id: string; name: string; based_on: string | null; applies_to: string | null; created_by: string; created_at: string };
type VersionRow = { team_id: string; workflow_id: string; version: number; graph: WorkflowGraph; note: string; created_by: string; created_at: string };

const memory = processMemory("workflows", () => ({
  workflows: new Map<string, WorkflowRow>(),
  versions: new Map<string, VersionRow[]>(),
  /** team id → the canvas's default workflow id. */
  defaults: new Map<string, string>(),
  /** Stored copies: reads and writes clone, like rows. */
  runs: new Map<string, WorkflowRunRecord>(),
}));

/** Clears the in-memory workflows and runs (tests; also runs with resetMemoryStore). */
export function resetWorkflowStore() {
  memory.workflows.clear();
  memory.versions.clear();
  memory.defaults.clear();
  memory.runs.clear();
}
onMemoryStoreReset(resetWorkflowStore);

// --- Built-ins ------------------------------------------------------------------------

function builtInSaved(key: string, version?: number): SavedWorkflow | null {
  const def = builtInWorkflow(key);
  if (!def || (version !== undefined && version !== def.version)) return null;
  return {
    workflow_id: builtInId(key),
    name: def.title,
    version: def.version,
    graph: compileWorkflow(def),
    note: "Built-in",
    created_by: "system",
    created_at: EPOCH,
    readOnly: true,
    based_on: null,
  };
}

/** The built-in workflows as the canvas lists them. */
export function builtInList(): Array<{ id: string; title: string }> {
  return builtInWorkflows().map((w) => ({ id: builtInId(w.key), title: w.title }));
}

function builtInInfo(): WorkflowInfo[] {
  return builtInWorkflows().map((w) => ({
    id: builtInId(w.key),
    name: w.title,
    based_on: null,
    applies_to: null,
    builtIn: true,
    created_by: "system",
    created_at: EPOCH,
    latestVersion: w.version,
    updated_at: EPOCH,
  }));
}

// --- Workflows and their versions --------------------------------------------------

/** The team's workflows, oldest first; with `includeBuiltIns`, the built-ins after them. */
export async function listWorkflows(teamId: string, opts: { includeBuiltIns?: boolean } = {}): Promise<WorkflowInfo[]> {
  let own: WorkflowInfo[];
  if (!hasDb()) {
    own = [...memory.workflows.values()]
      .filter((w) => w.team_id === teamId)
      .map((w) => {
        const last = memory.versions.get(w.id)?.at(-1);
        return { id: w.id, name: w.name, based_on: w.based_on, applies_to: w.applies_to ?? null, builtIn: false, created_by: w.created_by, created_at: w.created_at, latestVersion: last?.version ?? 0, updated_at: last?.created_at ?? w.created_at };
      });
  } else {
    await schema();
    const { rows } = await sql`
      SELECT w.id, w.name, w.based_on, w.applies_to, w.created_by, w.created_at, COALESCE(MAX(v.version), 0) AS latest, COALESCE(MAX(v.created_at), w.created_at) AS updated_at
        FROM workflow w LEFT JOIN workflow_version v ON v.workflow_id = w.id AND v.team_id = w.team_id
       WHERE w.team_id = ${teamId}
       GROUP BY w.id ORDER BY w.created_at, w.name`;
    own = rows.map((r) => ({
      id: r.id,
      name: r.name,
      based_on: r.based_on ?? null,
      applies_to: r.applies_to ?? null,
      builtIn: false,
      created_by: r.created_by,
      created_at: iso(r.created_at),
      latestVersion: Number(r.latest),
      updated_at: iso(r.updated_at),
    }));
  }
  return opts.includeBuiltIns ? [...own, ...builtInInfo()] : own;
}

async function workflowRow(teamId: string, id: string): Promise<WorkflowRow | null> {
  if (!hasDb()) {
    const w = memory.workflows.get(id);
    return w && w.team_id === teamId ? w : null;
  }
  await schema();
  const { rows } = await sql`SELECT id, team_id, name, based_on, applies_to, created_by, created_at FROM workflow WHERE id = ${id} AND team_id = ${teamId}`;
  const r = rows[0];
  return r ? { id: r.id, team_id: r.team_id, name: r.name, based_on: r.based_on ?? null, applies_to: r.applies_to ?? null, created_by: r.created_by, created_at: iso(r.created_at) } : null;
}

/**
 * A workflow's version: the newest when `version` is omitted. Built-ins
 * ("builtin:<key>") compile from the catalog and have one version, the
 * definition's. A team workflow with no saved version reads as the starting
 * graph (version 0). Null for an unknown workflow or version, or another team's.
 */
export async function getWorkflow(teamId: string, workflowId: string, version?: number): Promise<SavedWorkflow | null> {
  const key = parseBuiltInId(workflowId);
  if (key !== null) return builtInSaved(key, version);
  const w = await workflowRow(teamId, workflowId);
  if (!w) return null;
  const starting = (): SavedWorkflow => ({ workflow_id: w.id, name: w.name, version: 0, graph: defaultWorkflowGraph(), note: "Starting graph", created_by: "system", created_at: w.created_at, readOnly: false, based_on: w.based_on });
  if (version === 0) return starting();
  let row: Omit<VersionRow, "team_id" | "workflow_id"> | undefined;
  if (!hasDb()) {
    const all = memory.versions.get(w.id) ?? [];
    row = version === undefined ? all.at(-1) : all.find((v) => v.version === version);
  } else {
    const { rows } =
      version === undefined
        ? await sql`SELECT version, graph, note, created_by, created_at FROM workflow_version WHERE team_id = ${teamId} AND workflow_id = ${w.id} ORDER BY version DESC LIMIT 1`
        : await sql`SELECT version, graph, note, created_by, created_at FROM workflow_version WHERE team_id = ${teamId} AND workflow_id = ${w.id} AND version = ${version}`;
    if (rows[0]) row = { version: Number(rows[0].version), graph: rows[0].graph, note: rows[0].note, created_by: rows[0].created_by, created_at: iso(rows[0].created_at) };
  }
  if (!row) return version === undefined ? starting() : null;
  // A version saved in a format that no longer reads falls back to the starting graph rather than breaking every run.
  return { ...row, workflow_id: w.id, name: w.name, graph: normalizeGraph(row.graph) ?? defaultWorkflowGraph(), readOnly: false, based_on: w.based_on };
}

/** A workflow's saved versions, newest first (none for a built-in). */
export async function listVersions(teamId: string, workflowId: string): Promise<VersionInfo[]> {
  if (parseBuiltInId(workflowId) !== null) return [];
  if (!hasDb()) {
    const w = memory.workflows.get(workflowId);
    if (!w || w.team_id !== teamId) return [];
    return [...(memory.versions.get(workflowId) ?? [])].reverse().map(({ version, note, created_by, created_at }) => ({ version, note, created_by, created_at }));
  }
  await schema();
  const { rows } = await sql`SELECT version, note, created_by, created_at FROM workflow_version WHERE team_id = ${teamId} AND workflow_id = ${workflowId} ORDER BY version DESC`;
  return rows.map((r) => ({ version: Number(r.version), note: r.note, created_by: r.created_by, created_at: iso(r.created_at) }));
}

/** Save a new version of a team workflow; it becomes the version that runs by default. Built-ins are refused (ReadOnlyWorkflowError). */
export async function saveWorkflow(teamId: string, workflowId: string, graph: WorkflowGraph, note: string, auth: Auth): Promise<SavedWorkflow> {
  if (parseBuiltInId(workflowId) !== null) throw new ReadOnlyWorkflowError();
  const w = await workflowRow(teamId, workflowId);
  if (!w) throw new Error(`workflow not found: ${workflowId}`);
  let saved: SavedWorkflow;
  if (hasDb()) {
    // The next number is taken in the insert itself, so two saves can't share one.
    const { rows } = await sql`
      INSERT INTO workflow_version (team_id, workflow_id, version, graph, note, created_by)
      SELECT ${teamId}, ${w.id}, COALESCE(MAX(version), 0) + 1, ${JSON.stringify(graph)}::jsonb, ${note}, ${auth.agent}
        FROM workflow_version WHERE team_id = ${teamId} AND workflow_id = ${w.id}
      RETURNING version, created_at`;
    saved = { workflow_id: w.id, name: w.name, version: Number(rows[0].version), graph, note, created_by: auth.agent, created_at: iso(rows[0].created_at), readOnly: false, based_on: w.based_on };
  } else {
    const all = memory.versions.get(w.id) ?? [];
    const row: VersionRow = { team_id: teamId, workflow_id: w.id, version: all.length + 1, graph: clone(graph), note, created_by: auth.agent, created_at: new Date().toISOString() };
    memory.versions.set(w.id, [...all, row]);
    saved = { workflow_id: w.id, name: w.name, version: row.version, graph, note, created_by: auth.agent, created_at: row.created_at, readOnly: false, based_on: w.based_on };
  }
  await defaultAuditSink().write({
    agent: auth.agent,
    action: "save_workflow_version",
    args: { workflow_id: w.id, note },
    result: { version: saved.version, nodes: graph.nodes.length },
    allowed: true,
  });
  return saved;
}

/** createWorkflow's options: the workflow it was copied from, and the document type it is bound to. */
export type CreateWorkflowOptions = { basedOn?: string; appliesTo?: string; note?: string };

/**
 * Create a team workflow, starting from `graph` as its version 1. The fifth
 * argument is the options, or (as before Phase 8) the `basedOn` id alone.
 */
export async function createWorkflow(teamId: string, name: string, graph: WorkflowGraph, auth: Auth, options?: string | CreateWorkflowOptions): Promise<WorkflowInfo> {
  const opts: CreateWorkflowOptions = typeof options === "string" ? { basedOn: options } : (options ?? {});
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workflow";
  const id = `${slug}-${randomUUID().slice(0, 8)}`;
  const based_on = opts.basedOn ?? null;
  const applies_to = opts.appliesTo ?? null;
  if (hasDb()) {
    await schema();
    await sql`INSERT INTO workflow (id, team_id, name, based_on, applies_to, created_by) VALUES (${id}, ${teamId}, ${name}, ${based_on}, ${applies_to}, ${auth.agent})`;
  } else {
    memory.workflows.set(id, { id, team_id: teamId, name, based_on, applies_to, created_by: auth.agent, created_at: new Date().toISOString() });
  }
  let first: SavedWorkflow;
  try {
    await defaultAuditSink().write({ agent: auth.agent, action: "create_workflow", args: { name, based_on, applies_to }, result: { id }, allowed: true });
    first = await saveWorkflow(teamId, id, graph, opts.note ?? (based_on ? `Copied from ${based_on}` : "Created"), auth);
  } catch (error) {
    // No row without its version 1 (a bound row with no versions would still be offered for the type).
    await deleteWorkflow(teamId, id).catch(() => {});
    throw error;
  }
  return { id, name, based_on, applies_to, builtIn: false, created_by: auth.agent, created_at: first.created_at, latestVersion: first.version, updated_at: first.created_at };
}

/** Delete a team workflow and its versions (a learned save that fails part way). False for a built-in, an unknown id or another team's. */
export async function deleteWorkflow(teamId: string, id: string): Promise<boolean> {
  if (parseBuiltInId(id) !== null) return false;
  if (!hasDb()) {
    const w = memory.workflows.get(id);
    if (!w || w.team_id !== teamId) return false;
    memory.workflows.delete(id);
    memory.versions.delete(id);
    return true;
  }
  await schema();
  await sql`DELETE FROM workflow_version WHERE team_id = ${teamId} AND workflow_id = ${id}`;
  const { rowCount } = await sql`DELETE FROM workflow WHERE id = ${id} AND team_id = ${teamId}`;
  return !!rowCount;
}

/** Rename a team workflow. False for a built-in, an unknown id or another team's. */
export async function renameWorkflow(teamId: string, id: string, name: string, auth: Auth): Promise<boolean> {
  if (parseBuiltInId(id) !== null) return false;
  let ok: boolean;
  if (!hasDb()) {
    const w = memory.workflows.get(id);
    ok = !!w && w.team_id === teamId;
    if (ok) w!.name = name;
  } else {
    await schema();
    const { rowCount } = await sql`UPDATE workflow SET name = ${name} WHERE id = ${id} AND team_id = ${teamId}`;
    ok = !!rowCount;
  }
  await defaultAuditSink().write({ agent: auth.agent, action: "rename_workflow", args: { id, name }, result: { ok }, allowed: true });
  return ok;
}

async function workflowExists(teamId: string, id: string): Promise<boolean> {
  const key = parseBuiltInId(id);
  return key !== null ? !!builtInWorkflow(key) : !!(await workflowRow(teamId, id));
}

/**
 * The workflow the canvas opens first: the team's setting when it still
 * exists, else the team's oldest workflow, else the first built-in. Null when
 * there are none at all.
 */
export async function getDefaultWorkflowId(teamId: string): Promise<string | null> {
  let id: string | undefined;
  if (!hasDb()) id = memory.defaults.get(teamId);
  else {
    await schema();
    const { rows } = await sql`SELECT value FROM app_setting WHERE team_id = ${teamId} AND key = 'default_workflow'`;
    id = rows[0]?.value?.id;
  }
  if (id && (await workflowExists(teamId, id))) return id;
  const own = await listWorkflows(teamId);
  return own[0]?.id ?? builtInList()[0]?.id ?? null;
}

export async function setDefaultWorkflowId(teamId: string, id: string, auth: Auth): Promise<boolean> {
  if (!(await workflowExists(teamId, id))) return false;
  if (!hasDb()) memory.defaults.set(teamId, id);
  else
    await sql`INSERT INTO app_setting (team_id, key, value, updated_by) VALUES (${teamId}, 'default_workflow', ${JSON.stringify({ id })}::jsonb, ${auth.agent})
              ON CONFLICT (team_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await defaultAuditSink().write({ agent: auth.agent, action: "set_default_workflow", args: { id }, result: { ok: true }, allowed: true });
  return true;
}

// --- Runs -------------------------------------------------------------------------------

/**
 * Start a run of `workflow` on a document. Earlier runs of the same workflow
 * on the same document that are still active (running, awaiting review or
 * paused) are superseded; other workflows' runs are left alone.
 */
export async function createRun(teamId: string, documentId: string, workflow: SavedWorkflow, params: RunParams, auth: Auth): Promise<WorkflowRunRecord> {
  const now = new Date().toISOString();
  const run: WorkflowRunRecord = {
    id: randomUUID(),
    team_id: teamId,
    document_id: documentId,
    status: "running",
    pause_reason: null,
    workflow_id: workflow.workflow_id,
    workflow_name: workflow.name,
    workflow_version: workflow.version,
    graph: workflow.graph,
    params,
    steps: Object.fromEntries(workflow.graph.nodes.map((n) => [n.id, { status: "pending" as const }])),
    outputs: {},
    checkpoints: {},
    outcome: null,
    changes: {},
    responses: {},
    raw: {},
    requested_by: auth.agent,
    created_at: now,
    updated_at: now,
  };
  if (hasDb()) {
    await schema();
    // sql.query: the tagged template only accepts primitives, and this binds an array.
    await sql.query(
      `UPDATE workflow_run SET status = 'superseded', updated_at = now()
        WHERE team_id = $1 AND document_id = $2 AND workflow_id = $3 AND status = ANY($4)`,
      [teamId, documentId, workflow.workflow_id, ACTIVE_RUN_STATUSES],
    );
    await sql`INSERT INTO workflow_run (id, team_id, document_id, status, workflow_id, workflow_name, workflow_version, graph, params, steps, outputs, checkpoints, outcome, changes, responses, raw, requested_by)
              VALUES (${run.id}, ${teamId}, ${documentId}, 'running', ${run.workflow_id}, ${run.workflow_name}, ${run.workflow_version}, ${JSON.stringify(run.graph)}::jsonb,
                      ${JSON.stringify(params)}::jsonb, ${JSON.stringify(run.steps)}::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${auth.agent})`;
  } else {
    for (const r of memory.runs.values()) {
      if (r.team_id === teamId && r.document_id === documentId && r.workflow_id === workflow.workflow_id && ACTIVE_RUN_STATUSES.includes(r.status)) {
        r.status = "superseded";
        r.updated_at = now;
      }
    }
    memory.runs.set(run.id, clone(run));
  }
  await defaultAuditSink().write({
    agent: auth.agent,
    action: "start_workflow_run",
    args: { documentId, workflow_id: workflow.workflow_id, workflow_version: workflow.version, params },
    result: { runId: run.id },
    allowed: true,
  });
  return run;
}

/**
 * Persist the run's mutable state (status, steps, outputs, checkpoints,
 * outcome, raw replies). Changes and finding responses are written by their
 * own functions so a run in progress can't overwrite them. A run another start
 * superseded stays superseded, and `run.status` is set to say so.
 */
export async function saveRun(run: WorkflowRunRecord): Promise<void> {
  run.updated_at = new Date().toISOString();
  if (!hasDb()) {
    const stored = memory.runs.get(run.id);
    // Like the UPDATE below: a run deleted with its document is not brought back.
    if (!stored) return;
    if (stored.status === "superseded") {
      run.status = "superseded";
      return;
    }
    memory.runs.set(run.id, { ...clone(run), changes: stored.changes ?? {}, responses: stored.responses ?? {} });
    return;
  }
  const { rows } = await sql`UPDATE workflow_run
            SET status = CASE WHEN status = 'superseded' THEN status ELSE ${run.status} END,
                pause_reason = ${run.pause_reason}, steps = ${JSON.stringify(run.steps)}::jsonb, outputs = ${JSON.stringify(run.outputs)}::jsonb,
                checkpoints = ${JSON.stringify(run.checkpoints)}::jsonb, outcome = ${run.outcome ? JSON.stringify(run.outcome) : null}::jsonb,
                raw = ${JSON.stringify(run.raw)}::jsonb, updated_at = now()
            WHERE id = ${run.id} AND team_id = ${run.team_id}
            RETURNING status`;
  if (rows[0]?.status === "superseded") run.status = "superseded";
}

/**
 * A running run with no progress for this long is treated as dead. Runs execute
 * in the request's after() under a 300-second limit (the engine pauses itself
 * well before that), so a "running" row this old means the function was stopped
 * before it could record anything.
 */
export const STALE_RUN_MS = 6 * 60 * 1000;

/** Report a run that stopped responding as failed, without rewriting the stored row. */
export function withStaleCheck<T extends Pick<WorkflowRunRecord, "status" | "updated_at" | "steps">>(run: T | null, now = Date.now()): T | null {
  if (!run || run.status !== "running" || now - new Date(run.updated_at).getTime() < STALE_RUN_MS) return run;
  return {
    ...run,
    status: "failed",
    steps: Object.fromEntries(
      Object.entries(run.steps).map(([k, s]) => [k, s.status === "running" || s.status === "pending" ? { ...s, status: "failed" as const, error: "stopped responding; run again" } : s]),
    ),
  };
}

/** One of the team's runs, or null (unknown, or another team's). */
export async function getRun(teamId: string, runId: string): Promise<WorkflowRunRecord | null> {
  if (!hasDb()) {
    const r = memory.runs.get(runId);
    return r && r.team_id === teamId ? withStaleCheck(clone(r)) : null;
  }
  await schema();
  const { rows } = await sql`SELECT * FROM workflow_run WHERE id = ${runId} AND team_id = ${teamId}`;
  return withStaleCheck(normalizeRun(rows[0]));
}

/**
 * Delete every run of a document (when the document is deleted). Runs hold
 * copies of the document's content (extracted items, quotes, rationales), so
 * they go with it. A run still executing finds its row gone and saves nothing.
 */
export async function deleteDocumentRuns(teamId: string, documentId: string): Promise<number> {
  if (!hasDb()) {
    let n = 0;
    for (const [id, r] of memory.runs) {
      if (r.team_id === teamId && r.document_id === documentId) {
        memory.runs.delete(id);
        n++;
      }
    }
    return n;
  }
  await schema();
  const { rowCount } = await sql`DELETE FROM workflow_run WHERE team_id = ${teamId} AND document_id = ${documentId}`;
  return rowCount ?? 0;
}

// The columns a brief needs (outputs and graphs can be large).
const BRIEF_COLUMNS = "id, team_id, document_id, status, pause_reason, workflow_id, workflow_name, workflow_version, outcome, requested_by, created_at, updated_at, steps";

function briefOf(row: Record<string, unknown>): RunBrief {
  const run = withStaleCheck({
    ...row,
    status: row.status === "draft" ? ("complete" as const) : (row.status as RunStatus),
    steps: (row.steps as WorkflowRunRecord["steps"]) ?? {},
    updated_at: iso(row.updated_at),
  })!;
  return runBrief({
    ...(run as unknown as WorkflowRunRecord),
    document_id: String(row.document_id ?? ""),
    workflow_version: Number(row.workflow_version ?? 0),
    outcome: (row.outcome as WorkflowRunRecord["outcome"]) ?? null,
    created_at: iso(row.created_at),
  });
}

/** A document's runs, newest first, as briefs. */
export async function listDocumentRuns(teamId: string, documentId: string, limit = MAX_RUN_HISTORY): Promise<RunBrief[]> {
  const n = Math.min(Math.max(limit, 1), MAX_RUN_HISTORY);
  if (!hasDb()) {
    return [...memory.runs.values()]
      .filter((r) => r.team_id === teamId && r.document_id === documentId)
      .reverse()
      .slice(0, n)
      .map((r) => runBrief(withStaleCheck(r)!));
  }
  await schema();
  const { rows } = await sql.query(`SELECT ${BRIEF_COLUMNS} FROM workflow_run WHERE team_id = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT $3`, [teamId, documentId, n]);
  return rows.map(briefOf);
}

/** Each workflow's latest run on the document, by workflow id. */
export async function latestRuns(teamId: string, documentId: string): Promise<Record<string, RunBrief>> {
  const out: Record<string, RunBrief> = {};
  if (!hasDb()) {
    for (const r of memory.runs.values()) if (r.team_id === teamId && r.document_id === documentId) out[r.workflow_id] = runBrief(withStaleCheck(r)!);
    return out;
  }
  await schema();
  const { rows } = await sql.query(
    `SELECT DISTINCT ON (workflow_id) ${BRIEF_COLUMNS} FROM workflow_run
      WHERE team_id = $1 AND document_id = $2 ORDER BY workflow_id, created_at DESC`,
    [teamId, documentId],
  );
  for (const row of rows) out[String(row.workflow_id)] = briefOf(row);
  return out;
}

/** The team's newest runs across documents, without their outputs, for the canvas's run log and overview. */
export async function recentRunSummaries(teamId: string, limit: number): Promise<RunSummary[]> {
  if (!hasDb()) {
    return [...memory.runs.values()]
      .filter((r) => r.team_id === teamId)
      .reverse()
      .slice(0, limit)
      .map((r) => toRunSummary(withStaleCheck(r)!));
  }
  await schema();
  const { rows } = await sql`
    SELECT id, team_id, document_id, status, pause_reason, workflow_id, workflow_name, workflow_version, graph, steps, checkpoints, outcome, requested_by, created_at, updated_at
      FROM workflow_run WHERE team_id = ${teamId} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.flatMap((row) => {
    const run = withStaleCheck(normalizeRun({ ...row, outputs: {}, raw: {} }));
    return run ? [toRunSummary(run)] : [];
  });
}

/** The changes a run proposes: each doc.write node's `change` output, in graph order. */
export function proposedChanges(run: Pick<WorkflowRunRecord, "graph" | "outputs">): ProposedChange[] {
  return run.graph.nodes.flatMap((n) => {
    if (n.type !== "doc.write") return [];
    const change = run.outputs[n.id]?.change as ProposedChange | undefined;
    return change && typeof change === "object" && Array.isArray(change.ops) ? [change] : [];
  });
}

/** The run as the client sees it: no team id or raw replies, plus its proposed changes. */
export function runView(run: WorkflowRunRecord): WorkflowRunView {
  const { team_id: _t, raw: _r, ...rest } = run;
  void _t;
  void _r;
  return { ...rest, proposed: proposedChanges(run) };
}

/** Atomically merge one entry into a run's JSON column (changes or responses). Null when the run is not the team's. */
async function mergeEntry(teamId: string, runId: string, column: "changes" | "responses", key: string, value: unknown): Promise<WorkflowRunRecord | null> {
  if (!hasDb()) {
    const r = memory.runs.get(runId);
    if (!r || r.team_id !== teamId) return null;
    r[column] = { ...r[column], [key]: clone(value) } as never;
    r.updated_at = new Date().toISOString();
    return withStaleCheck(clone(r));
  }
  await schema();
  // The column name is one of two literals above; values are bound.
  const { rows } = await sql.query(
    `UPDATE workflow_run SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), updated_at = now()
      WHERE id = $1 AND team_id = $2 RETURNING *`,
    [runId, teamId, key, JSON.stringify(value)],
  );
  return withStaleCheck(normalizeRun(rows[0]));
}

/** Record what happened to a proposed change (applied in the editor, discarded, skipped). */
export function recordChangeResult(teamId: string, runId: string, changeId: string, result: ChangeResult): Promise<WorkflowRunRecord | null> {
  return mergeEntry(teamId, runId, "changes", changeId, result);
}

/**
 * Record a change's result only if none is recorded yet, atomically: "exists" when one already
 * is (a second tab, or a retry, racing the first), null when the run is not the team's. The
 * changes route uses it so two overlapping POSTs can't both record, the second overwriting the
 * lines the first applied.
 */
export async function recordChangeResultOnce(teamId: string, runId: string, changeId: string, result: ChangeResult): Promise<WorkflowRunRecord | "exists" | null> {
  if (!hasDb()) {
    const r = memory.runs.get(runId);
    if (!r || r.team_id !== teamId) return null;
    if (r.changes?.[changeId]) return "exists";
    return mergeEntry(teamId, runId, "changes", changeId, result);
  }
  await schema();
  const { rows } = await sql.query(
    `UPDATE workflow_run SET changes = COALESCE(changes, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), updated_at = now()
      WHERE id = $1 AND team_id = $2 AND NOT (COALESCE(changes, '{}'::jsonb) ? $3::text) RETURNING *`,
    [runId, teamId, changeId, JSON.stringify(result)],
  );
  if (rows[0]) return withStaleCheck(normalizeRun(rows[0]));
  const { rows: found } = await sql.query(`SELECT 1 FROM workflow_run WHERE id = $1 AND team_id = $2`, [runId, teamId]);
  return found.length ? "exists" : null;
}

/** Record the author's response to a finding (accept or dismiss; "open" undoes it). */
export function recordFindingResponse(teamId: string, runId: string, findingId: string, response: FindingResponse): Promise<WorkflowRunRecord | null> {
  return mergeEntry(teamId, runId, "responses", findingId, response);
}

export type RunAuditEntry = { ts: string; agent: string; action: string; allowed: boolean; note: string; result: unknown };

/**
 * The audit log's entries for one run, oldest first. Empty without a database (they go to the console).
 * The start entry records the run's ID in its result, the rest in their args; since Phase 9 the
 * run_id column also holds it, for the engine's entries and the run's model calls. Callers check
 * the team first (getRun).
 */
export async function runAuditTrail(runId: string): Promise<RunAuditEntry[]> {
  if (!hasDb()) return [];
  await ensureSchema("audit_log", AUDIT_LOG_SCHEMA);
  const { rows } = await sql`SELECT ts, agent, action, allowed, note, result FROM audit_log WHERE run_id = ${runId} OR args->>'runId' = ${runId} OR result->>'runId' = ${runId} ORDER BY ts ASC LIMIT 200`;
  return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), agent: r.agent, action: r.action, allowed: r.allowed, note: r.note, result: r.result }));
}

/**
 * Atomically move a run from `from` to running, so two clicks on Continue
 * cannot start it twice. Returns false when the run was not in `from`.
 * "running" in `from` only matches a run that stopped responding (older than
 * STALE_RUN_MS): a fresh running row has just been claimed by someone else.
 */
export async function claimRun(run: WorkflowRunRecord, from: RunStatus[]): Promise<boolean> {
  if (!from.includes(run.status)) return false;
  const now = new Date();
  if (hasDb()) {
    // sql.query: the tagged template only accepts primitives, and this binds an array.
    const { rows } = await sql.query(
      `UPDATE workflow_run SET status = 'running', pause_reason = NULL, updated_at = now()
        WHERE id = $1 AND team_id = $2 AND status = ANY($3)
          AND (status <> 'running' OR updated_at < now() - make_interval(secs => $4))
        RETURNING id`,
      [run.id, run.team_id, from, STALE_RUN_MS / 1000],
    );
    if (!rows.length) return false;
  } else {
    const stored = memory.runs.get(run.id);
    if (!stored || !from.includes(stored.status)) return false;
    if (stored.status === "running" && now.getTime() - new Date(stored.updated_at).getTime() < STALE_RUN_MS) return false;
    stored.status = "running";
    stored.pause_reason = null;
    stored.updated_at = now.toISOString();
  }
  run.status = "running";
  run.pause_reason = null;
  run.updated_at = now.toISOString();
  return true;
}

export async function auditRun(run: WorkflowRunRecord, action: string, result: unknown, note?: string, agent = "workflow_engine"): Promise<void> {
  await defaultAuditSink().write({ agent, action, args: { documentId: run.document_id, runId: run.id }, result, allowed: true, note, teamId: run.team_id, documentId: run.document_id, runId: run.id });
}
