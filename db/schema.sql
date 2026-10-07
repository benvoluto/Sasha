-- Postgres schema for Sasha. Works against any Postgres POSTGRES_URL (Neon's
-- connection string works unchanged).
--
-- Apply once per environment:  psql "$POSTGRES_URL" -f db/schema.sql
-- (or hit POST /api/ontology/setup, which runs this idempotently.)

CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent   TEXT NOT NULL,
  action  TEXT NOT NULL,
  args    JSONB NOT NULL,
  result  JSONB NOT NULL,
  allowed BOOLEAN NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  group_id TEXT               -- the upload-group this action concerned, when applicable
);
CREATE INDEX IF NOT EXISTS audit_log_group_idx ON audit_log (group_id);

-- The editable report. One long-lived report per upload group; content is
-- edited section by section. template_key picks the outline (see
-- src/lib/ontology/report/template.ts).
CREATE TABLE IF NOT EXISTS report (
  id            BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL,
  template_key  TEXT NOT NULL DEFAULT 'general_report',
  title         TEXT NOT NULL DEFAULT 'General Report',
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | final
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_group_uidx ON report (group_id);

-- One row per report section. content_json is the ProseMirror/Tiptap document;
-- content_text is a plain-text mirror for preview/export/search.
CREATE TABLE IF NOT EXISTS report_section (
  id            BIGSERIAL PRIMARY KEY,
  report_id     BIGINT NOT NULL,
  group_id      TEXT NOT NULL,
  section_key   TEXT NOT NULL,
  heading       TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  content_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_text  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | generating | ready | editing | reviewed
  source        TEXT NOT NULL DEFAULT 'ai',       -- ai | edited
  reviewed_by   TEXT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_section_uidx ON report_section (report_id, section_key);
CREATE INDEX IF NOT EXISTS report_section_group_idx ON report_section (group_id);

-- Workflow tables. These mirror WORKFLOW_SCHEMA in src/lib/workflow/store.ts,
-- which owns them and applies them on first use; keep the two in sync.

-- Named workflows. Each saved version (determination_workflow) belongs to one
-- and is numbered within it; runs record the workflow they used.
CREATE TABLE IF NOT EXISTS workflow (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO workflow (id, name, created_by) VALUES ('default', 'Default workflow', 'system') ON CONFLICT (id) DO NOTHING;

-- Workflow versions (node graphs) edited on the workflow canvas.
CREATE TABLE IF NOT EXISTS determination_workflow (
  id          BIGSERIAL PRIMARY KEY,
  definition  JSONB NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  workflow_id TEXT NOT NULL DEFAULT 'default',
  version     INTEGER
);
CREATE INDEX IF NOT EXISTS determination_workflow_version_idx ON determination_workflow (workflow_id, version DESC);

-- Workflow runs.
CREATE TABLE IF NOT EXISTS agent_determination_run (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running', -- running | awaiting_review | paused | draft | failed | superseded
  workflow_id       TEXT,
  workflow_name     TEXT,
  workflow_version  BIGINT NOT NULL DEFAULT 0,
  workflow          JSONB,           -- the graph the run used
  steps             JSONB,           -- per-node status
  outputs           JSONB,           -- per-node outputs
  checkpoints       JSONB,           -- decisions at human checkpoints
  raw               JSONB,
  proposals         JSONB,
  agreement         JSONB,
  synthesis         JSONB,
  requested_by      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_determination_run_group_idx ON agent_determination_run (group_id, created_at DESC);

-- The team's dismissed and added suggested sources/data per document.
CREATE TABLE IF NOT EXISTS case_suggestion_edits (
  group_id          TEXT PRIMARY KEY,
  edits             JSONB NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- App-wide settings, e.g. the default workflow ({"id": ...} under 'default_workflow').
CREATE TABLE IF NOT EXISTS app_setting (
  key               TEXT PRIMARY KEY,
  value             JSONB NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
