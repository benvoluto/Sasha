// Rubric check results and the check's interval gate (phase7-spec.md §3.2):
// one rubric_check row per document and scope ("doc" or "section:<id>")
// holding the last result and the hash of what it checked. The team's hourly
// cap moved to the shared limiter in Phase 9 (src/lib/limits, family "check");
// the rubric_check_call table stays in the DDL for older databases, but nothing
// writes it any more.
//
// Callers load the document for the caller's team first (the check route
// does), which also applies the document table the foreign key needs; the
// rubric tables follow with ensureSchema. Every read and write is scoped by
// team_id as well.
//
// Without POSTGRES_URL (local development, tests) rows live in process memory,
// cleared by resetMemoryStore() (documents store) or resetRubricCheckStore().

import { sql } from "@vercel/postgres";
import { onMemoryStoreReset } from "@/lib/documents/store";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { processMemory } from "@/lib/process-memory";
import { CHECK_MIN_INTERVAL_MS, type RubricCheckResponse } from "./contract";

/** Kept in step with db/schema.sql. */
export const RUBRIC_CHECK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rubric_check (
     team_id TEXT NOT NULL,
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     scope_key TEXT NOT NULL,
     inputs_hash TEXT NOT NULL,
     result JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (team_id, document_id, scope_key))`,
  `CREATE TABLE IF NOT EXISTS rubric_check_call (
     team_id TEXT NOT NULL,
     called_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS rubric_check_call_team_idx ON rubric_check_call (team_id, called_at)`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("rubric_check", RUBRIC_CHECK_SCHEMA);

export type StoredCheck = { scopeKey: string; inputsHash: string; result: RubricCheckResponse; createdAt: string };

const memory = processMemory("rubricCheck", () => ({
  checks: new Map<string, StoredCheck>(),
}));

/** Clears the in-memory checks (tests). resetMemoryStore() calls this too. */
export function resetRubricCheckStore() {
  memory.checks.clear();
}
onMemoryStoreReset(resetRubricCheckStore);

/** "doc" for the whole document, "section:<id>" for one section. */
export const checkScopeKey = (sectionId: string | null | undefined) => (sectionId ? `section:${sectionId}` : "doc");

const memKey = (teamId: string, documentId: string, scopeKey: string) => `${teamId}\u0000${documentId}\u0000${scopeKey}`;

// --- Results ---------------------------------------------------------------------

/** The last check for the scope, or null. */
export async function getStoredCheck(teamId: string, documentId: string, scopeKey: string): Promise<StoredCheck | null> {
  if (!hasDb()) return memory.checks.get(memKey(teamId, documentId, scopeKey)) ?? null;
  await schema();
  const { rows } = await sql`
    SELECT scope_key, inputs_hash, result, created_at FROM rubric_check
    WHERE team_id = ${teamId} AND document_id = ${documentId} AND scope_key = ${scopeKey}`;
  const r = rows[0];
  if (!r) return null;
  return { scopeKey: String(r.scope_key), inputsHash: String(r.inputs_hash), result: r.result as RubricCheckResponse, createdAt: new Date(r.created_at as string).toISOString() };
}

/** Store the scope's result (replacing the last one). */
export async function saveCheck(teamId: string, documentId: string, scopeKey: string, inputsHash: string, result: RubricCheckResponse, at = new Date()): Promise<void> {
  const createdAt = at.toISOString();
  if (!hasDb()) {
    memory.checks.set(memKey(teamId, documentId, scopeKey), { scopeKey, inputsHash, result, createdAt });
    return;
  }
  await schema();
  await sql`
    INSERT INTO rubric_check (team_id, document_id, scope_key, inputs_hash, result, created_at)
    VALUES (${teamId}, ${documentId}, ${scopeKey}, ${inputsHash}, ${JSON.stringify(result)}::jsonb, ${createdAt})
    ON CONFLICT (team_id, document_id, scope_key)
    DO UPDATE SET inputs_hash = EXCLUDED.inputs_hash, result = EXCLUDED.result, created_at = EXCLUDED.created_at`;
}

// --- Interval gate ---------------------------------------------------------------

export type GateResult = { ok: true } | { ok: false; reason: "interval"; retryAfterSeconds: number };

/**
 * Pure: the per-scope interval. A check of the same inputs within
 * CHECK_MIN_INTERVAL_MS of the last waits; changed inputs never do. It reads
 * the stored result, so it holds across instances.
 */
export function intervalGate(last: Pick<StoredCheck, "inputsHash" | "createdAt"> | null, inputsHash: string, now = Date.now()): GateResult {
  if (!last || last.inputsHash !== inputsHash) return { ok: true };
  const wait = Date.parse(last.createdAt) + CHECK_MIN_INTERVAL_MS - now;
  return wait > 0 ? { ok: false, reason: "interval", retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) } : { ok: true };
}
