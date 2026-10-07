import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { SUGGESTION_EDITS_SCHEMA } from "@/lib/ontology/suggestion-edits";
import { WORKFLOW_SCHEMA } from "@/lib/workflow/store";
import { DOCUMENT_SCHEMA } from "@/lib/documents/store";

export const runtime = "nodejs";

// Idempotent schema setup. Mirrors db/schema.sql (kept in sync); inlined here so
// it doesn't depend on runtime file access. The workflow tables come from
// WORKFLOW_SCHEMA in src/lib/workflow/store.ts, which owns them.
// POST /api/ontology/setup  — run once per environment after setting POSTGRES_URL.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS audit_log (
     id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
     agent TEXT NOT NULL, action TEXT NOT NULL, args JSONB NOT NULL, result JSONB NOT NULL,
     allowed BOOLEAN NOT NULL, note TEXT NOT NULL DEFAULT '', group_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_log_group_idx ON audit_log (group_id)`,
  // The editable report: one per upload group, edited section by section.
  `CREATE TABLE IF NOT EXISTS report (
     id BIGSERIAL PRIMARY KEY, group_id TEXT NOT NULL, template_key TEXT NOT NULL DEFAULT 'general_report',
     title TEXT NOT NULL DEFAULT 'General Report', status TEXT NOT NULL DEFAULT 'draft',
     created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_group_uidx ON report (group_id)`,
  `CREATE TABLE IF NOT EXISTS report_section (
     id BIGSERIAL PRIMARY KEY, report_id BIGINT NOT NULL, group_id TEXT NOT NULL, section_key TEXT NOT NULL,
     heading TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
     content_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT 'ai',
     reviewed_by TEXT, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_section_uidx ON report_section (report_id, section_key)`,
  `CREATE INDEX IF NOT EXISTS report_section_group_idx ON report_section (group_id)`,
  // The team's dismissed and added suggestions per document (also applied on first use).
  ...SUGGESTION_EDITS_SCHEMA,
  // Named workflows, their versions, runs, and app settings (also applied on first use).
  ...WORKFLOW_SCHEMA,
  ...DOCUMENT_SCHEMA,
  // Run columns the engine writes; added here for databases created before them.
  `ALTER TABLE agent_determination_run ADD COLUMN IF NOT EXISTS outputs JSONB`,
  `ALTER TABLE agent_determination_run ADD COLUMN IF NOT EXISTS checkpoints JSONB`,
];

const EXPECTED_TABLES = [
  "audit_log",
  "report",
  "report_section",
  "case_suggestion_edits",
  "app_setting",
  "workflow",
  "determination_workflow",
  "agent_determination_run",
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
    "determination_workflow.workflow_id": !!columns.determination_workflow?.includes("workflow_id"),
    "agent_determination_run.outputs": !!columns.agent_determination_run?.includes("outputs"),
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
