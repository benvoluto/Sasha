// Phase 9 columns on audit_log, so model usage can be summed per team, user,
// task, model and day (src/lib/usage). Older rows keep NULLs and are read from
// their JSON (args.task, result.model) where they can be. Kept in step with
// db/schema.sql and /api/ontology/setup; the Postgres sink also applies these on
// first use.
export const AUDIT_LOG_SCHEMA = [
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS team_id TEXT`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_id TEXT`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS document_id TEXT`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS run_id TEXT`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS task TEXT`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS model TEXT`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS latency_ms INTEGER`,
  `CREATE INDEX IF NOT EXISTS audit_log_team_ts_idx ON audit_log (team_id, ts)`,
];
