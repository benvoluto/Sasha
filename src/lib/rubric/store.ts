// Rubric check results and the check's rate gate (phase7-spec.md §3.2): one
// rubric_check row per document and scope ("doc" or "section:<id>") holding
// the last result and the hash of what it checked, and rubric_check_call rows
// counting a team's model checks over the last hour.
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
import { CHECK_MIN_INTERVAL_MS, CHECK_TEAM_HOURLY_LIMIT, type RubricCheckResponse } from "./contract";

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
const HOUR_MS = 3_600_000;

export type StoredCheck = { scopeKey: string; inputsHash: string; result: RubricCheckResponse; createdAt: string };

const memory = processMemory("rubricCheck", () => ({
  checks: new Map<string, StoredCheck>(),
  calls: new Map<string, number[]>(),
}));

/** Clears the in-memory checks and counters (tests). resetMemoryStore() calls this too. */
export function resetRubricCheckStore() {
  memory.checks.clear();
  memory.calls.clear();
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

// --- Rate gate -------------------------------------------------------------------

/** Count one model check for the team (and forget calls older than an hour). */
export async function recordModelCheck(teamId: string, now = Date.now()): Promise<void> {
  if (!hasDb()) {
    memory.calls.set(teamId, [...(memory.calls.get(teamId) ?? []).filter((t) => t > now - HOUR_MS), now]);
    return;
  }
  await schema();
  await sql`DELETE FROM rubric_check_call WHERE team_id = ${teamId} AND called_at <= ${new Date(now - HOUR_MS).toISOString()}`;
  await sql`INSERT INTO rubric_check_call (team_id, called_at) VALUES (${teamId}, ${new Date(now).toISOString()})`;
}

/** The team's model checks in the last hour, and when the oldest of them was made (epoch ms; null with none). */
export async function recentModelChecks(teamId: string, now = Date.now()): Promise<{ count: number; oldest: number | null }> {
  const since = now - HOUR_MS;
  if (!hasDb()) {
    const recent = (memory.calls.get(teamId) ?? []).filter((t) => t > since);
    return { count: recent.length, oldest: recent.length ? Math.min(...recent) : null };
  }
  await schema();
  const { rows } = await sql`
    SELECT count(*)::int AS n, min(called_at) AS oldest FROM rubric_check_call
    WHERE team_id = ${teamId} AND called_at > ${new Date(since).toISOString()}`;
  const n = Number(rows[0]?.n ?? 0);
  return { count: n, oldest: n && rows[0]?.oldest ? new Date(rows[0].oldest as string).getTime() : null };
}

export type GateResult = { ok: true } | { ok: false; reason: "interval" | "hourly"; retryAfterSeconds: number };

/**
 * Pure: the per-scope interval. A check of the same inputs within
 * CHECK_MIN_INTERVAL_MS of the last waits; changed inputs never do.
 */
export function intervalGate(last: Pick<StoredCheck, "inputsHash" | "createdAt"> | null, inputsHash: string, now = Date.now()): GateResult {
  if (!last || last.inputsHash !== inputsHash) return { ok: true };
  const wait = Date.parse(last.createdAt) + CHECK_MIN_INTERVAL_MS - now;
  return wait > 0 ? { ok: false, reason: "interval", retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) } : { ok: true };
}

const hourlyRefusal = (oldest: number | null, now: number): GateResult => {
  const wait = (oldest ?? now) + HOUR_MS - now;
  return { ok: false, reason: "hourly", retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
};

/**
 * May the scope run a model check now? The interval first, then the team's
 * hourly limit; when both pass, the call is counted in the same step, so
 * parallel requests can't all read a count under the limit before any of them
 * records (the route reserves before the model call). In memory the count and
 * the push are synchronous; on Postgres a per-team advisory lock holds the
 * count and the insert together across instances.
 */
export async function reserveModelCheck(teamId: string, last: StoredCheck | null, inputsHash: string, now = Date.now()): Promise<GateResult> {
  const interval = intervalGate(last, inputsHash, now);
  if (!interval.ok) return interval;
  const since = now - HOUR_MS;
  if (!hasDb()) {
    const recent = (memory.calls.get(teamId) ?? []).filter((t) => t > since);
    if (recent.length >= CHECK_TEAM_HOURLY_LIMIT) return hourlyRefusal(Math.min(...recent), now);
    memory.calls.set(teamId, [...recent, now]);
    return { ok: true };
  }
  await schema();
  const client = await sql.connect();
  try {
    await client.sql`BEGIN`;
    await client.sql`SELECT pg_advisory_xact_lock(hashtext(${`rubric_check_call:${teamId}`}))`;
    await client.sql`DELETE FROM rubric_check_call WHERE team_id = ${teamId} AND called_at <= ${new Date(since).toISOString()}`;
    const { rows } = await client.sql`
      SELECT count(*)::int AS n, min(called_at) AS oldest FROM rubric_check_call
      WHERE team_id = ${teamId} AND called_at > ${new Date(since).toISOString()}`;
    const n = Number(rows[0]?.n ?? 0);
    if (n >= CHECK_TEAM_HOURLY_LIMIT) {
      await client.sql`ROLLBACK`;
      return hourlyRefusal(rows[0]?.oldest ? new Date(rows[0].oldest as string).getTime() : null, now);
    }
    await client.sql`INSERT INTO rubric_check_call (team_id, called_at) VALUES (${teamId}, ${new Date(now).toISOString()})`;
    await client.sql`COMMIT`;
    return { ok: true };
  } catch (error) {
    await client.sql`ROLLBACK`.catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
