import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkflowGraph } from "./default-graph";

// The other store tests run on the in-memory fallback; these check the SQL the
// workflow store builds: team scoping everywhere, per-(document, workflow)
// superseding, the superseded guard on save, and atomic change/response merges.
type Call = { text: string; params: unknown[] };
const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (() => ({ rows: [] })) as (c: Call) => { rows: Record<string, unknown>[]; rowCount?: number },
}));
vi.mock("@vercel/postgres", () => {
  const run = async (text: string, params: unknown[]) => {
    const call = { text: text.replace(/\s+/g, " ").trim(), params };
    mocks.calls.push(call);
    const r = mocks.respond(call);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => run(strings.reduce((a, s, i) => a + `$${i}` + s), values);
  return { sql: Object.assign(sql, { query: (text: string, params: unknown[] = []) => run(text, params) }) };
});
vi.mock("@/lib/ontology/ensure-schema", () => ({ ensureSchema: async () => {} }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));

import { claimRun, createRun, createWorkflow, getDefaultWorkflowId, getRun, getWorkflow, latestRuns, recordChangeResult, saveRun, saveWorkflow, setDefaultWorkflowId, STALE_RUN_MS } from "./store";

const DOC = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";
const auth = { agent: "ann", permissions: [] };
const workflow = { workflow_id: "wf-1", name: "W", version: 2, graph: defaultWorkflowGraph(), note: "", created_by: "x", created_at: "", readOnly: false, based_on: null };
const runRow = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  team_id: "org:a",
  document_id: DOC,
  status: "complete",
  pause_reason: null,
  workflow_id: "wf-1",
  workflow_name: "W",
  workflow_version: "2",
  graph: defaultWorkflowGraph(),
  params: {},
  steps: {},
  outputs: {},
  checkpoints: {},
  outcome: null,
  changes: {},
  responses: {},
  raw: {},
  requested_by: "ann",
  created_at: "2026-10-08T12:00:00Z",
  updated_at: "2026-10-08T12:00:00Z",
  ...over,
});

beforeEach(() => {
  process.env.POSTGRES_URL = "postgres://test";
  mocks.calls.length = 0;
  mocks.respond = () => ({ rows: [] });
});

describe("workflow store SQL", () => {
  it("supersedes active runs of the same workflow on the same document only, then inserts the team's run", async () => {
    await createRun("org:a", DOC, workflow, { mode: "merge" }, auth);
    const [supersede, insert] = mocks.calls;
    expect(supersede.text).toMatch(/UPDATE workflow_run SET status = 'superseded'.*WHERE team_id = \$1 AND document_id = \$2 AND workflow_id = \$3 AND status = ANY\(\$4\)/);
    expect(supersede.params).toEqual(["org:a", DOC, "wf-1", ["running", "awaiting_review", "paused"]]);
    expect(insert.text).toMatch(/^INSERT INTO workflow_run \(id, team_id, document_id, status/);
    expect(insert.params.slice(1, 3)).toEqual(["org:a", DOC]);
  });

  it("never saves over a superseded run, and reports it", async () => {
    mocks.respond = () => ({ rows: [{ status: "superseded" }] });
    const run = { ...(await createRun("org:a", DOC, workflow, {}, auth)), status: "complete" as const };
    mocks.calls.length = 0;
    await saveRun(run);
    expect(mocks.calls[0].text).toMatch(/SET status = CASE WHEN status = 'superseded' THEN status ELSE \$1 END/);
    expect(mocks.calls[0].text).toMatch(/WHERE id = \$\d+ AND team_id = \$\d+ RETURNING status/);
    expect(mocks.calls[0].text).not.toMatch(/changes|responses/);
    expect(run.status).toBe("superseded");
  });

  it("reads runs by team and normalizes old rows", async () => {
    mocks.respond = () => ({ rows: [runRow({ status: "draft" })] });
    const run = await getRun("org:a", "r1");
    expect(mocks.calls[0]).toMatchObject({ text: "SELECT * FROM workflow_run WHERE id = $1 AND team_id = $2", params: ["r1", "org:a"] });
    expect(run).toMatchObject({ status: "complete", workflow_version: 2 });
  });

  it("picks the latest run per workflow on a document", async () => {
    mocks.respond = () => ({ rows: [runRow()] });
    const latest = await latestRuns("org:a", DOC);
    expect(mocks.calls[0].text).toMatch(/SELECT DISTINCT ON \(workflow_id\) .* FROM workflow_run WHERE team_id = \$1 AND document_id = \$2 ORDER BY workflow_id, created_at DESC/);
    expect(latest["wf-1"]).toMatchObject({ id: "r1", workflow_version: 2, outcome: null });
  });

  it("merges a change result into the run's changes atomically", async () => {
    mocks.respond = () => ({ rows: [runRow({ changes: { write: { result: "applied" } } })] });
    const run = await recordChangeResult("org:a", "r1", "write", { result: "applied", by: "ann", at: "t", detail: "" });
    expect(mocks.calls[0].text).toBe(
      "UPDATE workflow_run SET changes = COALESCE(changes, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), updated_at = now() WHERE id = $1 AND team_id = $2 RETURNING *",
    );
    expect(mocks.calls[0].params).toEqual(["r1", "org:a", "write", JSON.stringify({ result: "applied", by: "ann", at: "t", detail: "" })]);
    expect(run?.changes.write.result).toBe("applied");
  });

  it("claims within the team", async () => {
    mocks.respond = () => ({ rows: [{ id: "r1" }] });
    const run = { ...runRow({ status: "paused" }), workflow_version: 2 } as unknown as Parameters<typeof claimRun>[0];
    expect(await claimRun(run, ["paused"])).toBe(true);
    expect(mocks.calls[0].params).toEqual(["r1", "org:a", ["paused"], STALE_RUN_MS / 1000]);
    expect(mocks.calls[0].text).toMatch(/WHERE id = \$1 AND team_id = \$2 AND status = ANY\(\$3\)/);
    // A running row matches only once it has stopped responding: a fresh one was just claimed by another request.
    expect(mocks.calls[0].text).toMatch(/AND \(status <> 'running' OR updated_at < now\(\) - make_interval\(secs => \$4\)\)/);
  });

  it("scopes workflows, versions and the default to the team; built-ins never reach the database", async () => {
    expect(await getWorkflow("org:a", "builtin:missing")).toBeNull();
    await expect(saveWorkflow("org:a", "builtin:anything", defaultWorkflowGraph(), "", auth)).rejects.toThrow(/copy it first/);
    expect(mocks.calls).toEqual([]);

    mocks.respond = (c) => (c.text.startsWith("SELECT id, team_id, name") ? { rows: [{ id: "w1", team_id: "org:a", name: "Mine", based_on: null, created_by: "ann", created_at: "2026-10-08T12:00:00Z" }] } : { rows: [] });
    await setDefaultWorkflowId("org:a", "w1", auth);
    const upsert = mocks.calls.find((c) => c.text.startsWith("INSERT INTO app_setting"))!;
    expect(upsert.text).toMatch(/VALUES \(\$1, 'default_workflow', \$2::jsonb, \$3\) ON CONFLICT \(team_id, key\)/);
    expect(upsert.params).toEqual(["org:a", JSON.stringify({ id: "w1" }), "ann"]);

    mocks.calls.length = 0;
    await getDefaultWorkflowId("org:b");
    expect(mocks.calls[0]).toMatchObject({ text: "SELECT value FROM app_setting WHERE team_id = $1 AND key = 'default_workflow'", params: ["org:b"] });
  });

  it("stores a workflow's bound type (applies_to) in the insert", async () => {
    mocks.respond = (c) =>
      c.text.startsWith("SELECT id, team_id, name")
        ? { rows: [{ id: "w1", team_id: "org:a", name: "Learned", based_on: null, applies_to: "equipment-request", created_by: "ann", created_at: "2026-10-08T12:00:00Z" }] }
        : c.text.startsWith("INSERT INTO workflow_version")
          ? { rows: [{ version: 1, created_at: "2026-10-08T12:00:00Z" }] }
          : { rows: [] };
    const w = await createWorkflow("org:a", "Learned", defaultWorkflowGraph(), auth, { appliesTo: "equipment-request" });
    expect(w.applies_to).toBe("equipment-request");
    const insert = mocks.calls.find((c) => c.text.startsWith("INSERT INTO workflow ("))!;
    expect(insert.text).toMatch(/\(id, team_id, name, based_on, applies_to, created_by\)/);
    expect(insert.params.slice(1)).toEqual(["org:a", "Learned", null, "equipment-request", "ann"]);
  });
});
