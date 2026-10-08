// The workflow tables (PLAN §4.3, phase6-spec.md §1): named workflows, their
// versions, runs, and team settings, all scoped to a team; runs are scoped to a
// document too. Kept in step with db/schema.sql and spread into the setup
// route; src/lib/workflow/store.ts applies them on first use.
//
// Databases from before Phase 6 have the organizer's names
// (determination_workflow, agent_determination_run, a column per pipeline
// stage). The first statements rename them in place; rows from then keep
// team_id '' and are seen by no team (they ran on legacy upload groups).
//
// CONTRACT (Phase 6): owned by the engine-core track.

const columnExists = (table: string, column: string) =>
  `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}')`;

export const WORKFLOW_SCHEMA = [
  // --- Renames from the organizer's tables (no-ops once done) -------------------------
  `DO $$ BEGIN
     IF to_regclass('public.determination_workflow') IS NOT NULL AND to_regclass('public.workflow_version') IS NULL THEN
       ALTER TABLE determination_workflow RENAME TO workflow_version;
     END IF;
     IF to_regclass('public.agent_determination_run') IS NOT NULL AND to_regclass('public.workflow_run') IS NULL THEN
       ALTER TABLE agent_determination_run RENAME TO workflow_run;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF ${columnExists("workflow_version", "definition")} THEN ALTER TABLE workflow_version RENAME COLUMN definition TO graph; END IF;
     IF ${columnExists("workflow_run", "workflow")} THEN ALTER TABLE workflow_run RENAME COLUMN workflow TO graph; END IF;
     IF ${columnExists("workflow_run", "group_id")} THEN ALTER TABLE workflow_run ALTER COLUMN group_id DROP NOT NULL; END IF;
   END $$`,
  `DROP INDEX IF EXISTS determination_workflow_version_idx`,
  `DROP INDEX IF EXISTS agent_determination_run_group_idx`,

  // --- Workflows and versions --------------------------------------------------------------
  // A team's own workflows (made on the canvas, or copied from a built-in:
  // based_on). Built-in workflows are not stored; they ship in
  // src/catalog/workflows.bundle.json and run as "builtin:<key>".
  `CREATE TABLE IF NOT EXISTS workflow (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL,
     based_on TEXT,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `ALTER TABLE workflow ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE workflow ADD COLUMN IF NOT EXISTS based_on TEXT`,
  `CREATE INDEX IF NOT EXISTS workflow_team_idx ON workflow (team_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS workflow_version (
     id BIGSERIAL PRIMARY KEY,
     team_id TEXT NOT NULL DEFAULT '',
     workflow_id TEXT NOT NULL,
     version INTEGER,
     graph JSONB NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `ALTER TABLE workflow_version ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT ''`,
  // Number versions saved before per-workflow numbering, in the order they were saved.
  `UPDATE workflow_version d SET version = r.n
     FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY id) AS n FROM workflow_version) r
    WHERE d.id = r.id AND d.version IS NULL`,
  `CREATE INDEX IF NOT EXISTS workflow_version_wf_idx ON workflow_version (team_id, workflow_id, version DESC)`,

  // --- Team settings -----------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS app_setting (
     team_id TEXT NOT NULL DEFAULT '',
     key TEXT NOT NULL,
     value JSONB NOT NULL,
     updated_by TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (team_id, key))`,
  `ALTER TABLE app_setting ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT ''`,
  // Before Phase 6 the key alone was the primary key.
  `DO $$ BEGIN
     IF (SELECT count(*) FROM information_schema.key_column_usage
          WHERE table_schema = 'public' AND table_name = 'app_setting' AND constraint_name = 'app_setting_pkey') = 1 THEN
       ALTER TABLE app_setting DROP CONSTRAINT app_setting_pkey;
       ALTER TABLE app_setting ADD PRIMARY KEY (team_id, key);
     END IF;
   END $$`,

  // --- Runs --------------------------------------------------------------------------------
  // One row per run of a workflow on a document (contract.ts WorkflowRunRecord).
  // No foreign key to document: this table is applied without the document
  // tables. DELETE /api/documents/[id] deletes the document's runs with it
  // (store.ts deleteDocumentRuns), since runs hold copies of its content.
  `CREATE TABLE IF NOT EXISTS workflow_run (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL DEFAULT '',
     document_id UUID,
     status TEXT NOT NULL DEFAULT 'running',
     pause_reason TEXT,
     workflow_id TEXT,
     workflow_name TEXT,
     workflow_version BIGINT NOT NULL DEFAULT 0,
     graph JSONB,
     params JSONB,
     steps JSONB,
     outputs JSONB,
     checkpoints JSONB,
     outcome JSONB,
     changes JSONB,
     responses JSONB,
     raw JSONB,
     requested_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS document_id UUID`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS pause_reason TEXT`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS workflow_id TEXT`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS workflow_name TEXT`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS params JSONB`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS outputs JSONB`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS checkpoints JSONB`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS outcome JSONB`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS changes JSONB`,
  `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS responses JSONB`,
  `CREATE INDEX IF NOT EXISTS workflow_run_doc_idx ON workflow_run (team_id, document_id, created_at DESC)`,
];
