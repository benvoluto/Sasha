// Team-scoped requirement sets (PLAN §6.11: "requirement sets the example
// implies are saved as dated data, marked inferred") and the hourly cap on
// extractions. A requirement_set row is one team's inferred set (key prefixed
// "team-"); the catalog's own sets ship in requirements.bundle.json and are
// never stored here. Readers resolve catalog sets first, then these
// (availability.ts refs(), the requirements.read step), and show them as
// "Inferred from examples, not from the rules".
//
// learn_call rows count a team's extractions over the last hour.
//
// Without POSTGRES_URL (local development, tests) rows live in process memory,
// cleared by resetMemoryStore() (documents store) or resetLearnStore().

import { sql } from "@vercel/postgres";
import { requirementSet as catalogSet, requirementRef } from "@/catalog/workflows";
import { parseRequirementSet, type RequirementSet } from "@/catalog/requirements-schema";
import { onMemoryStoreReset } from "@/lib/documents/store";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { processMemory } from "@/lib/process-memory";
import type { RequirementRef } from "@/lib/workflow/contract";
import { LEARN_INFERRED_LABEL, LEARN_TEAM_HOURLY_LIMIT, TEAM_REQUIREMENT_SET_PREFIX } from "./contract";

/** Kept in step with db/schema.sql; spread into the setup route. */
export const LEARN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS requirement_set (
     team_id TEXT NOT NULL,
     key TEXT NOT NULL,
     definition JSONB NOT NULL,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (team_id, key))`,
  `CREATE TABLE IF NOT EXISTS learn_call (
     team_id TEXT NOT NULL,
     called_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS learn_call_team_idx ON learn_call (team_id, called_at)`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("learn", LEARN_SCHEMA);
const HOUR_MS = 3_600_000;

const memory = processMemory("learn", () => ({
  /** team id → key → definition (stored copies). */
  sets: new Map<string, Map<string, RequirementSet>>(),
  calls: new Map<string, number[]>(),
}));

/** Clears the in-memory sets and counters (tests). resetMemoryStore() calls this too. */
export function resetLearnStore() {
  memory.sets.clear();
  memory.calls.clear();
}
onMemoryStoreReset(resetLearnStore);

/** A stored row that no longer validates is skipped with a console error, never breaking a read. */
function parsedRow(teamId: string, key: string, raw: unknown): RequirementSet | null {
  const r = parseRequirementSet(raw);
  if (r.ok && r.set.inferred) return r.set;
  console.error("[learn] invalid stored requirement set skipped", teamId, key, r.ok ? "not inferred" : r.errors[0]);
  return null;
}

// --- Requirement sets ------------------------------------------------------------------

/** The team's inferred sets, sorted by key. */
export async function listTeamRequirementSets(teamId: string): Promise<RequirementSet[]> {
  if (!hasDb()) return [...(memory.sets.get(teamId)?.values() ?? [])].map((s) => structuredClone(s)).sort((a, b) => a.key.localeCompare(b.key));
  await schema();
  const { rows } = await sql`SELECT key, definition FROM requirement_set WHERE team_id = ${teamId} ORDER BY key`;
  return rows.flatMap((r) => {
    const s = parsedRow(teamId, String(r.key), r.definition);
    return s ? [s] : [];
  });
}

/**
 * Save inferred sets for the team. Each must parse, be inferred and carry the
 * team prefix; a key the team already has is refused (false), so a learned
 * workflow never silently reads another type's set.
 */
export async function insertTeamRequirementSets(teamId: string, agent: string, sets: RequirementSet[]): Promise<boolean> {
  for (const s of sets) {
    const r = parseRequirementSet(s);
    if (!r.ok || !r.set.inferred || !s.key.startsWith(TEAM_REQUIREMENT_SET_PREFIX)) throw new Error(`Invalid inferred requirement set ${s.key}`);
  }
  if (!sets.length) return true;
  if (!hasDb()) {
    const own = memory.sets.get(teamId) ?? new Map<string, RequirementSet>();
    if (sets.some((s) => own.has(s.key))) return false;
    for (const s of sets) own.set(s.key, structuredClone(s));
    memory.sets.set(teamId, own);
    return true;
  }
  await schema();
  const client = await sql.connect();
  try {
    await client.sql`BEGIN`;
    for (const s of sets) {
      const { rows } = await client.sql`
        INSERT INTO requirement_set (team_id, key, definition, created_by)
        VALUES (${teamId}, ${s.key}, ${JSON.stringify(s)}::jsonb, ${agent})
        ON CONFLICT (team_id, key) DO NOTHING RETURNING key`;
      if (!rows.length) {
        await client.sql`ROLLBACK`;
        return false;
      }
    }
    await client.sql`COMMIT`;
    return true;
  } catch (error) {
    await client.sql`ROLLBACK`.catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Remove the team's sets (when a learned save fails after they were written). */
export async function deleteTeamRequirementSets(teamId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  if (!hasDb()) {
    const own = memory.sets.get(teamId);
    for (const k of keys) own?.delete(k);
    return;
  }
  await schema();
  await sql.query(`DELETE FROM requirement_set WHERE team_id = $1 AND key = ANY($2)`, [teamId, keys]);
}

/** How an inferred set is cited: never as a rule, always with the label. */
export function inferredRef(set: RequirementSet): RequirementRef {
  return { ...requirementRef(set), url: "", verifyNote: `${LEARN_INFERRED_LABEL}. ${set.verifyNote}` };
}

/** A set by key: the catalog's first, then the team's (from `teamSets`). */
export function resolveSet(key: string, teamSets: RequirementSet[]): RequirementSet | null {
  return catalogSet(key) ?? teamSets.find((s) => s.key === key) ?? null;
}

/** A set's reference, labelled when inferred. */
export const setRef = (set: RequirementSet): RequirementRef => (set.inferred ? inferredRef(set) : requirementRef(set));

// --- Rate gate -------------------------------------------------------------------------

export type LearnGate = { ok: true } | { ok: false; retryAfterSeconds: number };

const refusal = (oldest: number | null, now: number): LearnGate => ({ ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((oldest ?? now) + HOUR_MS - now) / 1000)) });

/**
 * May the team run an extraction now? Counts it in the same step when it may,
 * so parallel requests can't all pass (an advisory lock holds the count and
 * the insert together on Postgres).
 */
export async function reserveLearnCall(teamId: string, now = Date.now()): Promise<LearnGate> {
  const since = now - HOUR_MS;
  if (!hasDb()) {
    const recent = (memory.calls.get(teamId) ?? []).filter((t) => t > since);
    if (recent.length >= LEARN_TEAM_HOURLY_LIMIT) return refusal(Math.min(...recent), now);
    memory.calls.set(teamId, [...recent, now]);
    return { ok: true };
  }
  await schema();
  const client = await sql.connect();
  try {
    await client.sql`BEGIN`;
    await client.sql`SELECT pg_advisory_xact_lock(hashtext(${`learn_call:${teamId}`}))`;
    await client.sql`DELETE FROM learn_call WHERE team_id = ${teamId} AND called_at <= ${new Date(since).toISOString()}`;
    const { rows } = await client.sql`
      SELECT count(*)::int AS n, min(called_at) AS oldest FROM learn_call
      WHERE team_id = ${teamId} AND called_at > ${new Date(since).toISOString()}`;
    if (Number(rows[0]?.n ?? 0) >= LEARN_TEAM_HOURLY_LIMIT) {
      await client.sql`ROLLBACK`;
      return refusal(rows[0]?.oldest ? new Date(rows[0].oldest as string).getTime() : null, now);
    }
    await client.sql`INSERT INTO learn_call (team_id, called_at) VALUES (${teamId}, ${new Date(now).toISOString()})`;
    await client.sql`COMMIT`;
    return { ok: true };
  } catch (error) {
    await client.sql`ROLLBACK`.catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
