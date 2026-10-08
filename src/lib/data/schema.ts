// The data tables (PLAN §4.3, phase5-spec.md §1). Kept in step with
// db/schema.sql and spread into the setup route after SOURCE_SCHEMA;
// src/lib/data/store.ts applies them on first use, after the document and
// source tables their foreign keys need.
//
// Rows live in data_row (one per table row, cells as a JSON array aligned with
// data_table.columns) so a 5,000-row table can be paged without loading the
// whole thing; the column is `cells` because VALUES is reserved in SQL. A
// person's change to a cell is a data_cell_override row (current value plus
// the original) and an audit_log entry per change.
//
// CONTRACT (Phase 5): owned by the data-api track.

export const DATA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS data_table (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL DEFAULT 0,
     match_key TEXT NOT NULL,
     name TEXT NOT NULL,
     columns JSONB NOT NULL,
     row_count INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'hidden')),
     superseded_by UUID REFERENCES data_table(id) ON DELETE SET NULL,
     extraction_method TEXT NOT NULL CHECK (extraction_method IN ('csv', 'xlsx', 'gemini-pdf', 'gemini-image')),
     sheet TEXT,
     page INTEGER,
     page_end INTEGER,
     confidence REAL,
     notes TEXT NOT NULL DEFAULT '',
     truncated BOOLEAN NOT NULL DEFAULT false,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS data_table_team_source_idx ON data_table (team_id, source_id, status)`,
  `CREATE TABLE IF NOT EXISTS data_row (
     table_id UUID NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL,
     cells JSONB NOT NULL,
     PRIMARY KEY (table_id, idx))`,
  `CREATE TABLE IF NOT EXISTS data_cell_override (
     table_id UUID NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
     row_idx INTEGER NOT NULL,
     col_key TEXT NOT NULL,
     value TEXT,
     original TEXT,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (table_id, row_idx, col_key))`,
  `CREATE TABLE IF NOT EXISTS document_data (
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     table_id UUID NOT NULL REFERENCES data_table(id) ON DELETE CASCADE,
     team_id TEXT NOT NULL,
     added_by TEXT NOT NULL,
     added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (document_id, table_id))`,
  `CREATE INDEX IF NOT EXISTS document_data_table_idx ON document_data (table_id)`,
];
