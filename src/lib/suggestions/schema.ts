// The suggestion tables (PLAN §4.3, phase4-spec.md §4.1). Kept in step with
// db/schema.sql and spread into the setup route; src/lib/suggestions/store.ts
// applies them on first use. Replaces the organizer's case_suggestion_edits.
//
// CONTRACT (Phase 4): owned by the suggestions track.

export const SUGGESTION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS suggestion (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     label TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     spec_ref TEXT,
     url TEXT,
     origin TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'open',
     dedupe_key TEXT NOT NULL,
     source_id UUID,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS suggestion_doc_dedupe_uidx ON suggestion (document_id, dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS suggestion_team_doc_idx ON suggestion (team_id, document_id, state)`,
  // One row per document: the inputs hash and time of the last generation, for
  // `stale` and the rate gate across server processes.
  `CREATE TABLE IF NOT EXISTS suggestion_run (
     document_id UUID PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
     team_id TEXT NOT NULL,
     inputs_hash TEXT NOT NULL,
     generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     error TEXT)`,
];
