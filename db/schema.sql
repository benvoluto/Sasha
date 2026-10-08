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

-- case_suggestion_edits was retired in Phase 4 (see the suggestion table below); older databases may still have it, nothing reads it.

-- App-wide settings, e.g. the default workflow ({"id": ...} under 'default_workflow').
CREATE TABLE IF NOT EXISTS app_setting (
  key               TEXT PRIMARY KEY,
  value             JSONB NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS suggestion_doc_dedupe_uidx ON suggestion (document_id, dedupe_key);
CREATE INDEX IF NOT EXISTS suggestion_team_doc_idx ON suggestion (team_id, document_id, state);
CREATE TABLE IF NOT EXISTS suggestion_run (
  document_id        UUID PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  team_id            TEXT NOT NULL,
  inputs_hash        TEXT NOT NULL,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  error              TEXT
);
