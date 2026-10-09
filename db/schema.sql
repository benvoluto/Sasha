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

-- report and report_section (the organizer's per-upload-group report) were
-- retired in Phase 6; older databases may still have them, nothing reads them.

-- Workflow tables. These mirror WORKFLOW_SCHEMA in src/lib/workflow/schema.ts,
-- which owns them and applies them on first use; keep the two in sync.
-- Everything is scoped to a team (team_id); runs are scoped to a document.

-- Databases from before Phase 6 have the organizer's names; rename them in
-- place. Their rows keep team_id '' and are seen by no team.
DO $$ BEGIN
  IF to_regclass('public.determination_workflow') IS NOT NULL AND to_regclass('public.workflow_version') IS NULL THEN
    ALTER TABLE determination_workflow RENAME TO workflow_version;
  END IF;
  IF to_regclass('public.agent_determination_run') IS NOT NULL AND to_regclass('public.workflow_run') IS NULL THEN
    ALTER TABLE agent_determination_run RENAME TO workflow_run;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workflow_version' AND column_name = 'definition') THEN
    ALTER TABLE workflow_version RENAME COLUMN definition TO graph;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workflow_run' AND column_name = 'workflow') THEN
    ALTER TABLE workflow_run RENAME COLUMN workflow TO graph;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workflow_run' AND column_name = 'group_id') THEN
    ALTER TABLE workflow_run ALTER COLUMN group_id DROP NOT NULL;
  END IF;
END $$;
DROP INDEX IF EXISTS determination_workflow_version_idx;
DROP INDEX IF EXISTS agent_determination_run_group_idx;

-- A team's own workflows (made on the canvas, or copied from a built-in:
-- based_on). Built-in workflows ship in src/catalog/workflows.bundle.json and
-- run as "builtin:<key>"; they are not stored here.
CREATE TABLE IF NOT EXISTS workflow (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL,
  based_on          TEXT,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE workflow ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow ADD COLUMN IF NOT EXISTS based_on TEXT;
CREATE INDEX IF NOT EXISTS workflow_team_idx ON workflow (team_id, created_at);

-- Workflow versions (node graphs) edited on the workflow canvas, numbered per workflow.
CREATE TABLE IF NOT EXISTS workflow_version (
  id          BIGSERIAL PRIMARY KEY,
  team_id     TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL,
  version     INTEGER,
  graph       JSONB NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE workflow_version ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT '';
UPDATE workflow_version d SET version = r.n
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY id) AS n FROM workflow_version) r
 WHERE d.id = r.id AND d.version IS NULL;
CREATE INDEX IF NOT EXISTS workflow_version_wf_idx ON workflow_version (team_id, workflow_id, version DESC);

-- Team settings, e.g. the canvas's default workflow ({"id": ...} under 'default_workflow').
CREATE TABLE IF NOT EXISTS app_setting (
  team_id           TEXT NOT NULL DEFAULT '',
  key               TEXT NOT NULL,
  value             JSONB NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, key)
);
ALTER TABLE app_setting ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT '';
-- Before Phase 6 the key alone was the primary key.
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.key_column_usage
       WHERE table_schema = 'public' AND table_name = 'app_setting' AND constraint_name = 'app_setting_pkey') = 1 THEN
    ALTER TABLE app_setting DROP CONSTRAINT app_setting_pkey;
    ALTER TABLE app_setting ADD PRIMARY KEY (team_id, key);
  END IF;
END $$;

-- Workflow runs: one per run of a workflow on a document (src/lib/workflow/contract.ts
-- WorkflowRunRecord). No foreign key to document (applied without the document tables).
CREATE TABLE IF NOT EXISTS workflow_run (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL DEFAULT '',
  document_id       UUID,
  status            TEXT NOT NULL DEFAULT 'running', -- running | awaiting_review | paused | complete | failed | superseded
  pause_reason      TEXT,             -- budget | manual
  workflow_id       TEXT,             -- builtin:<key> or a workflow.id
  workflow_name     TEXT,
  workflow_version  BIGINT NOT NULL DEFAULT 0,
  graph             JSONB,            -- the graph the run used
  params            JSONB,            -- per-run inputs (restructure target type and mode)
  steps             JSONB,            -- per-node status
  outputs           JSONB,            -- per-node outputs
  checkpoints       JSONB,            -- decisions at human checkpoints (verdict, who, when)
  outcome           JSONB,            -- the outcome node's result
  changes           JSONB,            -- what happened to each proposed document change
  responses         JSONB,            -- the author's accept/dismiss per finding
  raw               JSONB,
  requested_by      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS document_id UUID;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS pause_reason TEXT;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS workflow_id TEXT;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS params JSONB;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS outputs JSONB;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS checkpoints JSONB;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS outcome JSONB;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS changes JSONB;
ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS responses JSONB;
CREATE INDEX IF NOT EXISTS workflow_run_doc_idx ON workflow_run (team_id, document_id, created_at DESC);

-- case_suggestion_edits was retired in Phase 4 (see the suggestion table below); older databases may still have it, nothing reads it.

-- Documents (src/lib/documents/store.ts owns these; keep in step with DOCUMENT_SCHEMA).
-- team_id is "org:<clerk org id>" or "user:<clerk user id>" for a personal team.
CREATE TABLE IF NOT EXISTS document (
  id                 UUID PRIMARY KEY,
  team_id            TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  type_key           TEXT,
  type_confidence    REAL,
  type_source        TEXT,            -- user | classifier | restructure
  content_json       JSONB NOT NULL,  -- the whole TipTap document
  content_text       TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  folder_id          UUID,
  archived           BOOLEAN NOT NULL DEFAULT false,
  created_by         TEXT NOT NULL,
  updated_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_classified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS document_team_updated_idx ON document (team_id, archived, updated_at DESC);

-- Per-section metadata; the section text lives in document.content_json.
CREATE TABLE IF NOT EXISTS document_section (
  document_id        UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  section_id         TEXT NOT NULL,
  spec_key           TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'empty',
  last_generated_at  TIMESTAMPTZ,
  PRIMARY KEY (document_id, section_id)
);
ALTER TABLE document_section ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Snapshots taken before large changes (rewrites, restructures, section deletes).
CREATE TABLE IF NOT EXISTS document_version (
  id                 BIGSERIAL PRIMARY KEY,
  document_id        UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  content_json       JSONB NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  reason             TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_version_doc_idx ON document_version (document_id, id DESC);

-- Document folders: one level, team-owned, shown in the documents panel
-- (src/lib/documents/store.ts DOCUMENT_SCHEMA owns these; folder-store.ts reads
-- and writes them). Not the sources-library `folder` table below:
-- document.folder_id is that link, document.doc_folder_id is this one.
CREATE TABLE IF NOT EXISTS document_folder (
  id                 UUID PRIMARY KEY,
  team_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_folder_team_name_uidx ON document_folder (team_id, lower(name));
ALTER TABLE document ADD COLUMN IF NOT EXISTS doc_folder_id UUID REFERENCES document_folder(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS document_team_doc_folder_idx ON document (team_id, doc_folder_id, archived, updated_at DESC);
-- Classifier memory (src/lib/classifier/contract.ts ClassifierState): last result,
-- "Not now" counts per type, drift baselines. Written without bumping updated_at.
ALTER TABLE document ADD COLUMN IF NOT EXISTS classifier_state JSONB;

-- The sources library (src/lib/sources/store.ts owns these; keep in step with SOURCE_SCHEMA).
-- Folders nest; a document's own folder has document_id set (one per document).
CREATE TABLE IF NOT EXISTS folder (
  id                 UUID PRIMARY KEY,
  team_id            TEXT NOT NULL,
  parent_id          UUID REFERENCES folder(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  document_id        UUID,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS folder_team_parent_idx ON folder (team_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS folder_team_document_uidx ON folder (team_id, document_id) WHERE document_id IS NOT NULL;

-- One uploaded file, web link or note. team_id is stored directly (not only via
-- the folder) so every query scopes to the team without a join.
CREATE TABLE IF NOT EXISTS source (
  id                 UUID PRIMARY KEY,
  team_id            TEXT NOT NULL,
  folder_id          UUID REFERENCES folder(id) ON DELETE SET NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('file', 'url', 'note')),
  title              TEXT,
  filename           TEXT,
  mime               TEXT,
  bytes              INTEGER,
  blob_url           TEXT,            -- never sent to the client; files go through /api/sources/[id]/file
  blob_pathname      TEXT,            -- sources/<team hash>/<source id>/<name>
  url                TEXT,            -- for kind = 'url'
  extracted_text     TEXT,
  extraction_status  TEXT NOT NULL DEFAULT 'pending', -- uploading | pending | extracting | summarizing | ready | partial | error
  extraction_error   TEXT,
  summary            TEXT,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_team_folder_idx ON source (team_id, folder_id, created_at DESC);

-- Which sources a document draws on.
CREATE TABLE IF NOT EXISTS document_source (
  document_id        UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  source_id          UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  role               TEXT,
  added_by           TEXT NOT NULL,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, source_id)
);
CREATE INDEX IF NOT EXISTS document_source_source_idx ON document_source (source_id);

-- Citable passages of a source's extracted text; id is "S<8 hex of source id>.P<idx>".
CREATE TABLE IF NOT EXISTS source_passage (
  source_id          UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  idx                INTEGER NOT NULL,
  id                 TEXT NOT NULL,
  page               INTEGER,
  start_offset       INTEGER NOT NULL, -- offsets into source.extracted_text
  end_offset         INTEGER NOT NULL,
  text               TEXT NOT NULL,
  PRIMARY KEY (source_id, idx)
);

-- Data tables read from sources (src/lib/data/schema.ts owns these; keep in step
-- with DATA_SCHEMA). One row per table found in a CSV, an XLSX sheet or a PDF;
-- a re-read supersedes the source's earlier tables. Rows are in data_row
-- (`cells`, because VALUES is reserved); a person's cell edits are
-- data_cell_override rows, each change also written to audit_log.
CREATE TABLE IF NOT EXISTS data_table (
  id                 UUID PRIMARY KEY,
  team_id            TEXT NOT NULL,
  source_id          UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  idx                INTEGER NOT NULL DEFAULT 0,      -- order within its extraction
  match_key          TEXT NOT NULL,                   -- csv | sheet:<name> | page:<n>#<k>, matched across re-reads
  name               TEXT NOT NULL,
  columns            JSONB NOT NULL,                  -- [{key, label, type, inferred, unit}]
  row_count          INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'hidden')),
  superseded_by      UUID REFERENCES data_table(id) ON DELETE SET NULL,
  extraction_method  TEXT NOT NULL CHECK (extraction_method IN ('csv', 'xlsx', 'gemini-pdf', 'gemini-image')),
  sheet              TEXT,
  page               INTEGER,
  page_end           INTEGER,
  confidence         REAL,                            -- Gemini tables only
  notes              TEXT NOT NULL DEFAULT '',
  truncated          BOOLEAN NOT NULL DEFAULT false,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_table_team_source_idx ON data_table (team_id, source_id, status);
CREATE TABLE IF NOT EXISTS data_row (
  table_id           UUID NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
  idx                INTEGER NOT NULL,
  cells              JSONB NOT NULL,                  -- display strings (or null), aligned with columns
  PRIMARY KEY (table_id, idx)
);
CREATE TABLE IF NOT EXISTS data_cell_override (
  table_id           UUID NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
  row_idx            INTEGER NOT NULL,
  col_key            TEXT NOT NULL,
  value              TEXT,                            -- the person's value (null = blank)
  original           TEXT,                            -- what the source said
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, row_idx, col_key)
);
CREATE TABLE IF NOT EXISTS document_data (
  document_id        UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  table_id           UUID NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
  team_id            TEXT NOT NULL,
  added_by           TEXT NOT NULL,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, table_id)
);
CREATE INDEX IF NOT EXISTS document_data_table_idx ON document_data (table_id);

-- Document types (src/catalog/store.ts owns this; keep in step with CATALOG_SCHEMA).
-- A team's edits of catalog file types ('override'; a NULL definition only sets
-- enabled) and its own types ('team'). Catalog file types live in
-- src/catalog/types/*.json, not here.
CREATE TABLE IF NOT EXISTS document_type (
  team_id            TEXT NOT NULL,
  key                TEXT NOT NULL,
  origin             TEXT NOT NULL,             -- 'override' (of a file type) | 'team' (team-made)
  version            INT NOT NULL DEFAULT 1,
  title              TEXT NOT NULL DEFAULT '',
  family             TEXT NOT NULL DEFAULT 'general',
  summary            TEXT NOT NULL DEFAULT '',
  definition         JSONB,                     -- NULL = row only toggles enabled on a file type
  provenance         JSONB,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_by         TEXT NOT NULL,
  updated_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, key)
);

-- Suggested sources, data and web resources per document (src/lib/suggestions/schema.ts
-- owns these; keep in step with SUGGESTION_SCHEMA). Replaces case_suggestion_edits.
CREATE TABLE IF NOT EXISTS suggestion (
  id                 UUID PRIMARY KEY,
  team_id            TEXT NOT NULL,
  document_id        UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,             -- source | data | web
  label              TEXT NOT NULL,
  reason             TEXT NOT NULL DEFAULT '',
  spec_ref           TEXT,                      -- the type section key it serves
  url                TEXT,
  origin             TEXT NOT NULL,             -- type | notes | coverage | user
  state              TEXT NOT NULL DEFAULT 'open',  -- open | added | dismissed
  dedupe_key         TEXT NOT NULL,             -- suggestionDedupeKey(kind, label)
  source_id          UUID,                      -- the linked source that satisfied it
  data_table_id      UUID,                      -- the data table that satisfied it (kind data; no FK)
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE suggestion ADD COLUMN IF NOT EXISTS data_table_id UUID;  -- Phase 5, for older databases
CREATE UNIQUE INDEX IF NOT EXISTS suggestion_doc_dedupe_uidx ON suggestion (document_id, dedupe_key);
CREATE INDEX IF NOT EXISTS suggestion_team_doc_idx ON suggestion (team_id, document_id, state);
CREATE TABLE IF NOT EXISTS suggestion_run (
  document_id        UUID PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  team_id            TEXT NOT NULL,
  inputs_hash        TEXT NOT NULL,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  error              TEXT
);

-- Rubric check results (src/lib/rubric/store.ts owns these; keep in step with
-- RUBRIC_CHECK_SCHEMA). One row per document and scope ('doc' | 'section:<id>'):
-- the last result and the hash of what it checked, for the cache and the
-- per-scope interval. rubric_check_call counts a team's model checks for the
-- hourly limit (rows older than an hour are deleted as new ones arrive).
CREATE TABLE IF NOT EXISTS rubric_check (
  team_id            TEXT NOT NULL,
  document_id        UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  scope_key          TEXT NOT NULL,
  inputs_hash        TEXT NOT NULL,             -- sha256 of criteria, type key and version, text checked
  result             JSONB NOT NULL,            -- RubricCheckResponse
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, document_id, scope_key)
);
CREATE TABLE IF NOT EXISTS rubric_check_call (
  team_id            TEXT NOT NULL,
  called_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rubric_check_call_team_idx ON rubric_check_call (team_id, called_at);
