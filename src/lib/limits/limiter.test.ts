import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Postgres is mocked (active only while POSTGRES_URL is set): the memory tests
// run on the fallback, the SQL tests check the statements the limiter sends.
type Call = { text: string; params: unknown[] };
const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  released: 0,
  respond: (() => ({ rows: [] })) as (c: Call) => { rows: Record<string, unknown>[] },
}));
vi.mock("@vercel/postgres", () => {
  const run = async (text: string, params: unknown[]) => {
    const call = { text: text.replace(/\s+/g, " ").trim(), params };
    mocks.calls.push(call);
    return { rows: mocks.respond(call).rows };
  };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => run(strings.reduce((a, s, i) => a + `$${i}` + s), values);
  const sql = Object.assign(tag, {
    query: (text: string, params: unknown[] = []) => run(text, params),
    connect: async () => ({ sql: tag, release: () => void mocks.released++ }),
  });
  return { sql };
});

import { DEFAULT_LIMITS, type LimitBucket } from "./contract";
import { bucketsFor, checkModelCall, limitsFor, releaseModelCall, reserveBuckets, reserveModelCall, resetLimiter } from "./limiter";
import { MODEL_CALL_SCHEMA } from "./schema";

const HOUR = 3_600_000;
const t0 = Date.parse("2026-10-08T12:00:00Z");
const subject = { userId: "u1", teamId: "org:a" };
const bucket = (key: string, limit: number, windowMs = HOUR): LimitBucket & { scope: "user" } => ({ key, limit, windowMs, scope: "user" });

describe("limitsFor", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("uses the defaults, and parses SASHA_LIMIT_<FAMILY>_<SIDE> lists", () => {
    expect(limitsFor("draft", {})).toEqual(DEFAULT_LIMITS.draft);
    expect(limitsFor("draft", { SASHA_LIMIT_DRAFT_USER: "30/1h, 150/1d", SASHA_LIMIT_DRAFT_TEAM: "5/10m,2/30s" })).toEqual({
      user: [{ limit: 30, windowMs: HOUR }, { limit: 150, windowMs: 24 * HOUR }],
      team: [{ limit: 5, windowMs: 600_000 }, { limit: 2, windowMs: 30_000 }],
    });
    // The count before the unit is optional.
    expect(limitsFor("light", { SASHA_LIMIT_LIGHT_USER: "10/H" }).user).toEqual([{ limit: 10, windowMs: HOUR }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("turns a side off with 'off', and an empty value keeps the default", () => {
    expect(limitsFor("check", { SASHA_LIMIT_CHECK_USER: "OFF", SASHA_LIMIT_CHECK_TEAM: " " })).toEqual({ user: [], team: DEFAULT_LIMITS.check.team });
  });

  it("falls back to the default on an invalid value, warning once per value", () => {
    for (const bad of ["30", "0/1h", "30/1w", "30/0h", "abc", "30/1h,"]) {
      expect(limitsFor("export", { SASHA_LIMIT_EXPORT_TEAM: bad }).team).toEqual(DEFAULT_LIMITS.export.team);
    }
    limitsFor("export", { SASHA_LIMIT_EXPORT_TEAM: "30" });
    expect(warn).toHaveBeenCalledTimes(6);
    expect(String(warn.mock.calls[0][0])).toMatch(/SASHA_LIMIT_EXPORT_TEAM/);
  });

  it("names a bucket per window for the user and the team", () => {
    expect(bucketsFor(subject, "draft", {}).map((b) => [b.key, b.limit, b.scope])).toEqual([
      ["user:u1:draft:3600000", 30, "user"],
      ["user:u1:draft:86400000", 150, "user"],
      ["team:org:a:draft:86400000", 600, "team"],
    ]);
  });
});

describe("reserveBuckets in memory", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetLimiter();
  });

  it("allows up to the limit, then refuses with when the oldest call leaves the window", async () => {
    const b = bucket("k", 3);
    for (let i = 0; i < 3; i++) expect(await reserveBuckets([b], { now: t0 + i * 60_000 })).toEqual({ ok: true });
    expect(await reserveBuckets([b], { now: t0 + 10 * 60_000 })).toEqual({ ok: false, scope: "user", family: null, limit: 3, windowMs: HOUR, retryAfterSeconds: 50 * 60 });
    // Rollover: an hour after the first call there is room for one again.
    expect(await reserveBuckets([b], { now: t0 + HOUR })).toEqual({ ok: true });
    expect((await reserveBuckets([b], { now: t0 + HOUR }))).toMatchObject({ ok: false, retryAfterSeconds: 60 });
  });

  it("counts cost > 1 and waits for enough room, refusing a cost above the limit for a whole window", async () => {
    const b = bucket("k", 5);
    expect(await reserveBuckets([b], { cost: 3, now: t0 })).toEqual({ ok: true });
    expect(await reserveBuckets([b], { cost: 1, now: t0 + 1000 })).toEqual({ ok: true });
    // 4 used; 3 more need the first three (all at t0) to leave.
    expect(await reserveBuckets([b], { cost: 3, now: t0 + 2000 })).toMatchObject({ ok: false, retryAfterSeconds: 3600 - 2 });
    expect(await reserveBuckets([b], { cost: 1, now: t0 + 2000 })).toEqual({ ok: true });
    expect(await reserveBuckets([bucket("big", 2)], { cost: 3, now: t0 })).toMatchObject({ ok: false, retryAfterSeconds: 3600 });
    expect(await reserveBuckets([b], { cost: 0, now: t0 })).toEqual({ ok: true });
  });

  it("is all-or-nothing across buckets, and reports the longest wait", async () => {
    const user = { ...bucket("user", 10), scope: "user" as const };
    const team = { key: "team", limit: 2, windowMs: 600_000, scope: "team" as const, family: "draft" as const };
    expect(await reserveBuckets([user, team], { now: t0 })).toEqual({ ok: true });
    expect(await reserveBuckets([user, team], { now: t0 + 1000 })).toEqual({ ok: true });
    const refused = await reserveBuckets([user, team], { now: t0 + 2000 });
    expect(refused).toEqual({ ok: false, scope: "team", family: "draft", limit: 2, windowMs: 600_000, retryAfterSeconds: 598 });
    // Nothing was recorded for the user bucket by the refused call: 8 more fit.
    for (let i = 0; i < 8; i++) expect(await reserveBuckets([user], { now: t0 + 3000 })).toEqual({ ok: true });
    expect(await reserveBuckets([user], { now: t0 + 3000 })).toMatchObject({ ok: false });

    // Both full: the user's hour outlasts the team's 10 minutes.
    expect(await reserveBuckets([team, user], { now: t0 + 4000 })).toMatchObject({ scope: "user", retryAfterSeconds: 3596 });
  });

  it("a key bucket refuses as scope key", async () => {
    const doc = { key: "doc:org:a:d1:outline", limit: 1, windowMs: 20_000 };
    expect(await reserveBuckets([doc], { now: t0 })).toEqual({ ok: true });
    expect(await reserveBuckets([doc], { now: t0 + 5000 })).toEqual({ ok: false, scope: "key", family: null, limit: 1, windowMs: 20_000, retryAfterSeconds: 15 });
    expect(await reserveBuckets([doc], { now: t0 + 20_000 })).toEqual({ ok: true });
  });

  it("concurrent reservations in one process stop exactly at the limit", async () => {
    const env = process.env.SASHA_LIMIT_DRAFT_USER;
    process.env.SASHA_LIMIT_DRAFT_USER = "7/1h";
    try {
      const results = await Promise.all(Array.from({ length: 12 }, () => reserveModelCall(subject, "draft")));
      expect(results.filter((r) => r.ok)).toHaveLength(7);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.scope === "user" && r.family === "draft")).toBe(true);
    } finally {
      if (env === undefined) delete process.env.SASHA_LIMIT_DRAFT_USER;
      else process.env.SASHA_LIMIT_DRAFT_USER = env;
    }
  });

  it("reserveModelCall uses the family's user and team windows; another user shares only the team's", async () => {
    for (let i = 0; i < 4; i++) expect(await reserveModelCall(subject, "learn", { now: t0 })).toEqual({ ok: true });
    expect(await reserveModelCall(subject, "learn", { now: t0 })).toMatchObject({ ok: false, scope: "user", limit: 4 });
    const other = { userId: "u2", teamId: "org:a" };
    expect(await reserveModelCall(other, "learn", { now: t0 })).toEqual({ ok: true });
    expect(await reserveModelCall(other, "learn", { now: t0 })).toEqual({ ok: true });
    expect(await reserveModelCall(other, "learn", { now: t0 })).toMatchObject({ ok: false, scope: "team", limit: 6 });
    expect(await reserveModelCall({ userId: "u3", teamId: "org:b" }, "learn", { now: t0 })).toEqual({ ok: true });
  });

  it("record: false answers whether the calls would fit without recording them", async () => {
    const b = bucket("k", 3);
    expect(await reserveBuckets([b], { cost: 3, now: t0, record: false })).toEqual({ ok: true });
    expect(await reserveBuckets([b], { cost: 4, now: t0, record: false })).toMatchObject({ ok: false, retryAfterSeconds: 3600 });
    // Nothing was counted by the checks: all three still fit.
    expect(await reserveBuckets([b], { cost: 3, now: t0 })).toEqual({ ok: true });
    expect(await reserveBuckets([b], { now: t0 + 1000, record: false })).toMatchObject({ ok: false, retryAfterSeconds: 3599 });
    for (let i = 0; i < 2; i++) await reserveModelCall(subject, "learn", { now: t0 });
    expect(await checkModelCall(subject, "learn", { cost: 2, now: t0 })).toEqual({ ok: true });
    expect(await checkModelCall(subject, "learn", { cost: 3, now: t0 })).toMatchObject({ ok: false, scope: "user", family: "learn" });
    expect(await reserveModelCall(subject, "learn", { cost: 2, now: t0 })).toEqual({ ok: true });
  });

  it("releaseModelCall gives a reservation back", async () => {
    for (let i = 0; i < 4; i++) await reserveModelCall(subject, "learn", { now: t0 });
    await releaseModelCall(subject, "learn");
    expect(await reserveModelCall(subject, "learn", { now: t0 })).toEqual({ ok: true });
    expect(await reserveModelCall(subject, "learn", { now: t0 })).toMatchObject({ ok: false });
  });
});

describe("reserveBuckets on Postgres", () => {
  beforeEach(() => {
    process.env.POSTGRES_URL = "postgres://test";
    mocks.calls.length = 0;
    mocks.released = 0;
    mocks.respond = () => ({ rows: [] });
  });
  afterEach(() => {
    delete process.env.POSTGRES_URL;
  });

  const tx = () => mocks.calls.filter((c) => !c.text.startsWith("CREATE"));

  it("applies the schema, locks every bucket in key order, prunes, counts and inserts cost rows", async () => {
    mocks.respond = (c) => (c.text.startsWith("SELECT count") ? { rows: [{ n: 1 }] } : { rows: [] });
    const decision = await reserveBuckets([bucket("team:b", 10), bucket("user:a", 10, 600_000), bucket("team:b", 10)], { cost: 2, now: t0 });
    expect(decision).toEqual({ ok: true });
    expect(mocks.calls.slice(0, MODEL_CALL_SCHEMA.length).map((c) => c.text)).toEqual(MODEL_CALL_SCHEMA.map((s) => s.replace(/\s+/g, " ").trim()));
    const [begin, lock1, lock2, ...rest] = tx();
    expect(begin.text).toBe("BEGIN");
    expect(lock1.text).toBe("SELECT pg_advisory_xact_lock(hashtext('model_call:' || $1))");
    expect([lock1.params, lock2.params]).toEqual([["team:b"], ["user:a"]]);
    expect(rest[0]).toEqual({ text: "DELETE FROM model_call WHERE bucket = $1 AND called_at <= $2", params: ["team:b", new Date(t0 - HOUR).toISOString()] });
    expect(rest[1].text).toBe("SELECT count(*)::int AS n FROM model_call WHERE bucket = $1 AND called_at > $2");
    expect(rest[2].params).toEqual(["user:a", new Date(t0 - 600_000).toISOString()]);
    const inserts = rest.filter((c) => c.text.startsWith("INSERT"));
    expect(inserts.map((c) => c.text)).toEqual(Array(2).fill("INSERT INTO model_call (bucket, called_at) SELECT $1, $2 FROM generate_series(1, $3)"));
    expect(inserts.map((c) => c.params)).toEqual([
      ["team:b", new Date(t0).toISOString(), 2],
      ["user:a", new Date(t0).toISOString(), 2],
    ]);
    expect(rest.at(-1)!.text).toBe("COMMIT");
    expect(mocks.released).toBe(1);
  });

  it("rolls back on a refusal, inserting nothing, with the wait from the call that frees enough room", async () => {
    const oldest = t0 - 50 * 60_000;
    mocks.respond = (c) => {
      if (c.text.startsWith("SELECT count")) return { rows: [{ n: c.params[0] === "user:a" ? 10 : 0 }] };
      if (c.text.includes("OFFSET")) return { rows: [{ called_at: new Date(oldest).toISOString() }] };
      return { rows: [] };
    };
    const decision = await reserveBuckets([bucket("user:a", 10), { key: "team:a", limit: 100, windowMs: HOUR, scope: "team" as const }], { cost: 2, now: t0 });
    expect(decision).toEqual({ ok: false, scope: "user", family: null, limit: 10, windowMs: HOUR, retryAfterSeconds: 10 * 60 });
    const offset = tx().find((c) => c.text.includes("OFFSET"))!;
    // 10 + 2 - 10 - 1: the second-oldest call must leave too.
    expect(offset.text).toMatch(/ORDER BY called_at ASC, id ASC OFFSET \$3 LIMIT 1$/);
    expect(offset.params).toEqual(["user:a", new Date(t0 - HOUR).toISOString(), 1]);
    expect(tx().some((c) => c.text.startsWith("INSERT"))).toBe(false);
    expect(tx().at(-1)!.text).toBe("ROLLBACK");
    expect(mocks.released).toBe(1);
  });

  it("record: false counts under the same locks but inserts nothing", async () => {
    mocks.respond = (c) => (c.text.startsWith("SELECT count") ? { rows: [{ n: 1 }] } : { rows: [] });
    expect(await reserveBuckets([bucket("user:a", 10)], { cost: 2, now: t0, record: false })).toEqual({ ok: true });
    expect(tx().some((c) => c.text.startsWith("INSERT"))).toBe(false);
    expect(tx().at(-1)!.text).toBe("COMMIT");
    expect(mocks.released).toBe(1);
  });

  it("rolls back and rethrows when a statement fails", async () => {
    mocks.respond = (c) => {
      if (c.text.startsWith("SELECT count")) throw new Error("db down");
      return { rows: [] };
    };
    await expect(reserveBuckets([bucket("k", 1)], { now: t0 })).rejects.toThrow("db down");
    expect(tx().at(-1)!.text).toBe("ROLLBACK");
    expect(mocks.released).toBe(1);
  });

  it("releases the newest rows of each bucket", async () => {
    await releaseModelCall(subject, "check", { cost: 1 });
    const deletes = tx().filter((c) => c.text.startsWith("DELETE"));
    expect(deletes.map((c) => c.params)).toEqual([
      ["team:org:a:check:3600000", 1],
      ["user:u1:check:3600000", 1],
    ]);
    expect(deletes[0].text).toMatch(/ORDER BY called_at DESC, id DESC LIMIT \$2\)$/);
  });
});
