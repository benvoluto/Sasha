// The shared limiter's table (src/lib/limits/limiter.ts). One row per counted
// call per bucket; rows older than a bucket's window are pruned under the same
// advisory lock that counts them. Kept in step with db/schema.sql and
// /api/ontology/setup. The Phase 7/8 tables rubric_check_call and learn_call
// stay for older databases; nothing new writes them once the limiter owns
// those caps.
export const MODEL_CALL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS model_call (
     id BIGSERIAL PRIMARY KEY,
     bucket TEXT NOT NULL,
     called_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS model_call_bucket_idx ON model_call (bucket, called_at)`,
];
