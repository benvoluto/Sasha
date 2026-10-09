import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { WORKFLOW_SCHEMA } from "@/lib/workflow/schema";
import { DOCUMENT_SCHEMA } from "@/lib/documents/store";
import { SOURCE_SCHEMA } from "@/lib/sources/store";
import { CATALOG_SCHEMA } from "@/catalog/store";
import { SUGGESTION_SCHEMA } from "@/lib/suggestions/schema";
import { DATA_SCHEMA } from "@/lib/data/schema";
import { RUBRIC_CHECK_SCHEMA } from "@/lib/rubric/store";

export const runtime = "nodejs";

// Idempotent schema setup. Mirrors db/schema.sql (kept in sync); inlined here so
// it doesn't depend on runtime file access. The workflow tables come from
// WORKFLOW_SCHEMA in src/lib/workflow/schema.ts, which owns them.
// POST /api/ontology/setup  — run once per environment after setting POSTGRES_URL.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS audit_log (
     id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
     agent TEXT NOT NULL, action TEXT NOT NULL, args JSONB NOT NULL, result JSONB NOT NULL,
     allowed BOOLEAN NOT NULL, note TEXT NOT NULL DEFAULT '', group_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_log_group_idx ON audit_log (group_id)`,
  // (report and report_section, the organizer's per-upload-group report, were retired in Phase 6; older databases may still have them, nothing reads them.)
  // (case_suggestion_edits was retired in Phase 4; older databases may still have it, nothing reads it.)
  // Named workflows, their versions, runs, and team settings (also applied on
  // first use). Renames the organizer's determination_workflow and
  // agent_determination_run in place on older databases.
  ...WORKFLOW_SCHEMA,
  ...DOCUMENT_SCHEMA,
  // The sources library (after the documents: links reference document).
  ...SOURCE_SCHEMA,
  // Data tables read from sources, and their document links (src/lib/data/schema.ts).
  ...DATA_SCHEMA,
  // Team overrides and team-made document types (src/catalog/store.ts).
  ...CATALOG_SCHEMA,
  // Suggested sources, data and web resources per document (src/lib/suggestions/schema.ts).
  ...SUGGESTION_SCHEMA,
  // Rubric check results and the check's rate gate (after the documents: rows reference document).
  ...RUBRIC_CHECK_SCHEMA,
  `ALTER TABLE document_section ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
];

const EXPECTED_TABLES = [
  "audit_log",
  "app_setting",
  "workflow",
  "workflow_version",
  "workflow_run",
  "document",
  "document_section",
  "document_version",
  "document_folder",
  "folder",
  "source",
  "document_source",
  "source_passage",
  "data_table",
  "data_row",
  "data_cell_override",
  "document_data",
  "document_type",
  "suggestion",
  "suggestion_run",
  "rubric_check",
  "rubric_check_call",
];

/**
 * Report what the database ACTUALLY has, rather than a hardcoded list. Some
 * statements above add columns to existing tables, so a list of table names
 * alone can't tell you whether a migration took effect — which is exactly the
 * question this endpoint is used to answer.
 */
async function inspectSchema() {
  // sql.query (not the tagged template) — the tag only accepts primitives, and
  // this needs an array parameter.
  const { rows } = await sql.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [EXPECTED_TABLES],
  );
  const columns: Record<string, string[]> = {};
  for (const r of rows) {
    const t = String(r.table_name);
    (columns[t] ??= []).push(String(r.column_name));
  }
  const missingTables = EXPECTED_TABLES.filter((t) => !columns[t]);
  // Columns added by ALTER after the original CREATE — the ones most likely to
  // be absent on an older database, and the whole point of checking.
  const migrations = {
    "workflow.team_id": !!columns.workflow?.includes("team_id"),
    "workflow_version.graph": !!columns.workflow_version?.includes("graph"),
    "workflow_run.document_id": !!columns.workflow_run?.includes("document_id"),
    "workflow_run.outcome": !!columns.workflow_run?.includes("outcome"),
    "app_setting.team_id": !!columns.app_setting?.includes("team_id"),
    "document_section.updated_at": !!columns.document_section?.includes("updated_at"),
    "document.doc_folder_id": !!columns.document?.includes("doc_folder_id"),
    "document.classifier_state": !!columns.document?.includes("classifier_state"),
    "suggestion.data_table_id": !!columns.suggestion?.includes("data_table_id"),
  };
  return {
    ok: missingTables.length === 0 && Object.values(migrations).every(Boolean),
    tables: Object.keys(columns).sort(),
    missingTables,
    migrations,
    columns,
  };
}

/** GET — inspect the schema without changing anything. */
export async function GET() {
  if (!process.env.POSTGRES_URL) {
    return NextResponse.json({ error: "POSTGRES_URL is not configured" }, { status: 503 });
  }
  try {
    return NextResponse.json(await inspectSchema());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "inspect failed" }, { status: 500 });
  }
}

/** POST — run the idempotent create/alter statements, then report the result. */
export async function POST() {
  if (!process.env.POSTGRES_URL) {
    return NextResponse.json({ error: "POSTGRES_URL is not configured" }, { status: 503 });
  }
  try {
    for (const stmt of STATEMENTS) await sql.query(stmt);
    return NextResponse.json(await inspectSchema());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "setup failed" }, { status: 500 });
  }
}
