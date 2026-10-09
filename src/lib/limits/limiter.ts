// The shared model-call limiter (phase9-spec.md §2.2). A bucket counts calls
// over a rolling window; a reservation is all-or-nothing across its buckets (a
// user's windows and their team's), so a refused request records nothing.
//
// Postgres: one transaction takes pg_advisory_xact_lock per bucket in sorted
// key order (two requests sharing buckets can't deadlock), prunes rows that
// left each window, counts, and either refuses or inserts `cost` rows per
// bucket, so instances agree. Without POSTGRES_URL the counters live in process
// memory and the check and the push are synchronous, so concurrent callers in
// one process are atomic too.
//
// Limits come from DEFAULT_LIMITS (contract.ts), overridden per deployment by
// SASHA_LIMIT_<FAMILY>_<USER|TEAM> (e.g. "30/1h,150/1d", or "off").

import { sql } from "@vercel/postgres";
import { onMemoryStoreReset } from "@/lib/documents/store";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { processMemory } from "@/lib/process-memory";
import { DEFAULT_LIMITS, type FamilyLimits, type LimitBucket, type LimitDecision, type LimitFamily, type LimitRefusal, type LimitSubject, type LimitWindow } from "./contract";
import { MODEL_CALL_SCHEMA } from "./schema";

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("model_call", MODEL_CALL_SCHEMA);

/** Bucket key → call times (epoch ms, oldest first). */
const memory = processMemory("limits.calls", () => new Map<string, number[]>());

/** Clears the in-memory counters (tests). resetMemoryStore() calls this too. */
export function resetLimiter(): void {
  memory.clear();
}
onMemoryStoreReset(resetLimiter);

// --- Limits ----------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const WINDOW_RE = /^(\d+)\s*\/\s*(\d*)\s*([smhd])$/i;
const warned = new Set<string>();

/** "30/1h,150/1d" → windows; "off" → none; null when any part is invalid. */
function parseWindows(raw: string): LimitWindow[] | null {
  if (raw.trim().toLowerCase() === "off") return [];
  const out: LimitWindow[] = [];
  for (const part of raw.split(",")) {
    const m = WINDOW_RE.exec(part.trim());
    if (!m) return null;
    const limit = Number(m[1]);
    const n = m[2] ? Number(m[2]) : 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(n) || n < 1) return null;
    out.push({ limit, windowMs: n * UNIT_MS[m[3].toLowerCase()] });
  }
  return out;
}

function side(family: LimitFamily, scope: "user" | "team", env: Record<string, string | undefined>): LimitWindow[] {
  const name = `SASHA_LIMIT_${family.toUpperCase()}_${scope.toUpperCase()}`;
  const raw = env[name];
  if (raw === undefined || !raw.trim()) return DEFAULT_LIMITS[family][scope];
  const parsed = parseWindows(raw);
  if (parsed) return parsed;
  const once = `${name}=${raw}`;
  if (!warned.has(once)) {
    warned.add(once);
    console.warn(`[limits] ${name} is not a list like "30/1h,150/1d" or "off"; using the default.`);
  }
  return DEFAULT_LIMITS[family][scope];
}

/** The family's user and team windows, with any SASHA_LIMIT_* override applied. */
export function limitsFor(family: LimitFamily, env: Record<string, string | undefined> = process.env): FamilyLimits {
  return { user: side(family, "user", env), team: side(family, "team", env) };
}

/** Buckets for a subject: user:<userId>:<family>:<windowMs> and team:<teamId>:<family>:<windowMs>. */
export function bucketsFor(subject: LimitSubject, family: LimitFamily, env?: Record<string, string | undefined>): Array<LimitBucket & { scope: "user" | "team"; family: LimitFamily }> {
  const limits = limitsFor(family, env);
  return [
    ...limits.user.map((w) => ({ key: `user:${subject.userId}:${family}:${w.windowMs}`, ...w, scope: "user" as const, family })),
    ...limits.team.map((w) => ({ key: `team:${subject.teamId}:${family}:${w.windowMs}`, ...w, scope: "team" as const, family })),
  ];
}

// --- Reserving -------------------------------------------------------------------

type Bucket = LimitBucket & { scope?: "user" | "team" | "key"; family?: LimitFamily | null };

/** One copy per key, in sorted key order (the lock order). */
function uniqueSorted(buckets: Bucket[]): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const b of buckets) if (!byKey.has(b.key)) byKey.set(b.key, b);
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The refusal for a bucket holding `count` calls in its window, or null when
 * `cost` more fit. `oldestNeeded` is the call whose leaving the window frees
 * enough room (null when cost alone is over the limit: the whole window).
 */
function refusalFor(b: Bucket, count: number, cost: number, oldestNeeded: (index: number) => number | null, now: number): LimitRefusal | null {
  if (count + cost <= b.limit) return null;
  const at = cost > b.limit ? null : oldestNeeded(count + cost - b.limit - 1);
  const freesAt = (at ?? now) + b.windowMs;
  return { ok: false, scope: b.scope ?? "key", family: b.family ?? null, limit: b.limit, windowMs: b.windowMs, retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now) / 1000)) };
}

/** The refusal the caller has to wait longest for (it can't succeed sooner). */
const longest = (refusals: LimitRefusal[]) => refusals.reduce((a, b) => (b.retryAfterSeconds > a.retryAfterSeconds ? b : a));

/**
 * All-or-nothing: every bucket has room for `cost` → record cost rows in each
 * and ok; else nothing recorded. `record: false` only asks whether they would
 * fit (a pre-check before work that is charged later), and records nothing.
 */
export async function reserveBuckets(buckets: Bucket[], opts: { cost?: number; now?: number; record?: boolean } = {}): Promise<LimitDecision> {
  const cost = Math.max(0, Math.floor(opts.cost ?? 1));
  const now = opts.now ?? Date.now();
  const record = opts.record ?? true;
  const list = uniqueSorted(buckets);
  if (!list.length || cost === 0) return { ok: true };
  return hasDb() ? reserveSql(list, cost, now, record) : reserveMemory(list, cost, now, record);
}

function reserveMemory(list: Bucket[], cost: number, now: number, record: boolean): LimitDecision {
  // No await from here to the push: the check and the record are one step.
  const recent = list.map((b) => (memory.get(b.key) ?? []).filter((t) => t > now - b.windowMs));
  const refusals = list.flatMap((b, i) => refusalFor(b, recent[i].length, cost, (k) => recent[i][k] ?? null, now) ?? []);
  if (refusals.length) {
    list.forEach((b, i) => (recent[i].length ? memory.set(b.key, recent[i]) : memory.delete(b.key)));
    return longest(refusals);
  }
  if (record) list.forEach((b, i) => memory.set(b.key, [...recent[i], ...Array.from({ length: cost }, () => now)]));
  return { ok: true };
}

async function reserveSql(list: Bucket[], cost: number, now: number, record: boolean): Promise<LimitDecision> {
  await schema();
  const at = new Date(now).toISOString();
  const client = await sql.connect();
  try {
    await client.sql`BEGIN`;
    for (const b of list) await client.sql`SELECT pg_advisory_xact_lock(hashtext('model_call:' || ${b.key}))`;
    const refusals: LimitRefusal[] = [];
    for (const b of list) {
      const since = new Date(now - b.windowMs).toISOString();
      await client.sql`DELETE FROM model_call WHERE bucket = ${b.key} AND called_at <= ${since}`;
      const { rows } = await client.sql`SELECT count(*)::int AS n FROM model_call WHERE bucket = ${b.key} AND called_at > ${since}`;
      const count = Number(rows[0]?.n ?? 0);
      if (count + cost <= b.limit) continue;
      let oldest: number | null = null;
      if (cost <= b.limit) {
        const offset = count + cost - b.limit - 1;
        const { rows: r } = await client.sql`
          SELECT called_at FROM model_call WHERE bucket = ${b.key} AND called_at > ${since}
          ORDER BY called_at ASC, id ASC OFFSET ${offset} LIMIT 1`;
        oldest = r[0]?.called_at ? new Date(r[0].called_at as string).getTime() : null;
      }
      refusals.push(refusalFor(b, count, cost, () => oldest, now)!);
    }
    if (refusals.length) {
      await client.sql`ROLLBACK`;
      return longest(refusals);
    }
    if (!record) {
      // The prune above is harmless either way; keep it.
      await client.sql`COMMIT`;
      return { ok: true };
    }
    for (const b of list) await client.sql`INSERT INTO model_call (bucket, called_at) SELECT ${b.key}, ${at} FROM generate_series(1, ${cost})`;
    await client.sql`COMMIT`;
    return { ok: true };
  } catch (error) {
    await client.sql`ROLLBACK`.catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Reserve `cost` calls of the family for the subject's user and team windows. */
export async function reserveModelCall(subject: LimitSubject, family: LimitFamily, opts: { cost?: number; now?: number } = {}): Promise<LimitDecision> {
  return reserveBuckets(bucketsFor(subject, family), opts);
}

/** Would `cost` calls of the family fit the subject's windows right now? Records nothing. */
export async function checkModelCall(subject: LimitSubject, family: LimitFamily, opts: { cost?: number; now?: number } = {}): Promise<LimitDecision> {
  return reserveBuckets(bucketsFor(subject, family), { ...opts, record: false });
}

/** Give back a reservation when the model was never called (e.g. a 404 found after reserving). Optional use. */
export async function releaseModelCall(subject: LimitSubject, family: LimitFamily, opts: { cost?: number; now?: number } = {}): Promise<void> {
  const cost = Math.max(0, Math.floor(opts.cost ?? 1));
  if (!cost) return;
  const list = uniqueSorted(bucketsFor(subject, family));
  if (!hasDb()) {
    // The newest calls are this reservation's (or as good as: the counts are what matter).
    for (const b of list) {
      const times = memory.get(b.key);
      if (!times) continue;
      times.splice(Math.max(0, times.length - cost), cost);
      if (!times.length) memory.delete(b.key);
    }
    return;
  }
  await schema();
  for (const b of list) {
    await sql`
      DELETE FROM model_call WHERE id IN (
        SELECT id FROM model_call WHERE bucket = ${b.key} ORDER BY called_at DESC, id DESC LIMIT ${cost})`;
  }
}
