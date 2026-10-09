import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => ({ query: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })) }));
vi.mock("@vercel/postgres", () => ({ sql: Object.assign(vi.fn(async () => ({ rows: [] })), { query: sqlMock.query }) }));

import { memoryAuditSink, resetMemoryAudit, type AuditEntry } from "@/lib/ontology/governance";
import { PRICING_NOTE } from "@/lib/llm/pricing";
import { csvGroups, daysIn, loadUsageRows, MAX_USAGE_ROWS, resolveRange, summarize, usageFor, type UsageRow } from "./query";

const NOW = Date.parse("2026-10-08T12:00:00Z");

function call(over: Partial<AuditEntry> & { usage?: Record<string, number> } = {}): AuditEntry {
  const { usage, ...rest } = over;
  return {
    agent: "ann@x.org",
    action: "llm:draft.section",
    args: { task: "draft.section" },
    result: { model: rest.model ?? "claude-opus-5-5", input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    allowed: true,
    teamId: "org:a",
    userId: "u1",
    task: "draft.section",
    model: "claude-opus-5-5",
    ...rest,
  };
}

async function writeAt(iso: string, entry: AuditEntry) {
  vi.setSystemTime(new Date(iso));
  await memoryAuditSink.write(entry);
}

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  day: "2026-10-07",
  ts: "2026-10-07T10:00:00.000Z",
  user: "u1",
  label: "ann@x.org",
  task: "draft.section",
  model: "claude-opus-5-5",
  allowed: true,
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  web_search_requests: 0,
  ...over,
});

describe("resolveRange", () => {
  it("defaults to the last 30 days ending today", () => {
    expect(resolveRange({}, NOW)).toEqual({ from: "2026-09-09", to: "2026-10-08" });
    expect(resolveRange({ to: "2026-01-31" }, NOW)).toEqual({ from: "2026-01-02", to: "2026-01-31" });
  });

  it("refuses reversed, unreal and over-long ranges", () => {
    expect(resolveRange({ from: "2026-10-09" }, NOW)).toHaveProperty("error");
    expect(resolveRange({ from: "2026-02-30", to: "2026-03-01" }, NOW)).toEqual({ error: "2026-02-30 is not a real date." });
    expect(resolveRange({ from: "2025-01-01", to: "2026-01-01" }, NOW)).toEqual({ from: "2025-01-01", to: "2026-01-01" }); // 366 days
    expect(resolveRange({ from: "2024-12-31", to: "2026-01-01" }, NOW)).toHaveProperty("error");
  });

  it("lists every day in a range", () => {
    expect(daysIn({ from: "2026-02-27", to: "2026-03-02" })).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });
});

describe("summarize", () => {
  it("sums totals and groups, sorted by cost then calls, with byDay zero-filled", () => {
    const rows = [
      row(),
      row({ ts: "2026-10-07T11:00:00.000Z", task: "classify.type", model: "claude-haiku-5-5", input_tokens: 500, output_tokens: 10 }),
      row({ day: "2026-10-05", ts: "2026-10-05T09:00:00.000Z", user: "u2", label: "bo@x.org", allowed: false, input_tokens: 0, output_tokens: 0 }),
      row({ ts: "2026-10-07T12:00:00.000Z", label: "ann@new.org", web_search_requests: 2 }),
    ];
    const out = summarize(rows, { from: "2026-10-04", to: "2026-10-07" }, false);
    const opus = 1000 * 4e-6 + 100 * 20e-6;
    expect(out.totals).toMatchObject({ calls: 4, errors: 1, input_tokens: 2500, output_tokens: 210, web_search_requests: 2 });
    expect(out.totals.cost_usd).toBeCloseTo(2 * opus + 0.02 + 500 * 0.1e-6 + 10 * 0.5e-6, 4);
    expect(out.byTask.map((g) => g.task)).toEqual(["draft.section", "classify.type"]);
    expect(out.byModel.map((g) => [g.model, g.calls])).toEqual([
      ["claude-opus-5-5", 3],
      ["claude-haiku-5-5", 1],
    ]);
    expect(out.byUser.map((g) => [g.user, g.label, g.calls])).toEqual([
      ["u1", "ann@new.org", 3],
      ["u2", "bo@x.org", 1],
    ]);
    expect(out.byDay.map((d) => [d.day, d.calls])).toEqual([
      ["2026-10-04", 0],
      ["2026-10-05", 1],
      ["2026-10-06", 0],
      ["2026-10-07", 3],
    ]);
    expect(out.byDay[0].cost_usd).toBe(0);
    expect(out.pricing).toMatchObject({ note: PRICING_NOTE, unpricedModels: [] });
    expect(out.memoryOnly).toBe(false);
  });

  it("leaves a group's cost unknown when it used an unpriced model, and lists the model", () => {
    const out = summarize([row(), row({ task: "gemini.extract", model: "gemini-3.6-flash" })], { from: "2026-10-07", to: "2026-10-07" }, true);
    expect(out.totals.cost_usd).toBeNull();
    expect(out.byModel.find((g) => g.model === "claude-opus-5-5")?.cost_usd).toBeGreaterThan(0);
    expect(out.byModel.find((g) => g.model === "gemini-3.6-flash")?.cost_usd).toBeNull();
    expect(out.pricing.unpricedModels).toEqual(["gemini-3.6-flash"]);
    expect(out.totals.priced_cost_usd).toBe(out.byModel.find((g) => g.model === "claude-opus-5-5")?.cost_usd);
  });

  it("sorts people by their priced cost, so one unpriced upload doesn't sink a big spender below a small one", () => {
    const out = summarize(
      [
        row({ user: "a", label: "a@x", input_tokens: 2_000_000, output_tokens: 500_000 }),
        row({ user: "a", label: "a@x", task: "gemini.extract", model: "gemini-3.6-flash", input_tokens: 1000, output_tokens: 100 }),
        row({ user: "b", label: "b@x", model: "claude-haiku-5-5", input_tokens: 1000, output_tokens: 100 }),
      ],
      { from: "2026-10-07", to: "2026-10-07" },
      false,
    );
    expect(out.byUser.map((g) => [g.user, g.cost_usd === null])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(out.byUser[0].priced_cost_usd).toBeCloseTo(2_000_000 * 4e-6 + 500_000 * 20e-6, 4);
    expect(out.byDay[0]).toMatchObject({ cost_usd: null, priced_cost_usd: expect.any(Number) });
    expect(out.byDay[0].priced_cost_usd).toBeGreaterThan(out.byUser[0].priced_cost_usd);
  });

  it("does not count a failed call with no tokens as unpriced", () => {
    const out = summarize([row({ model: "unknown", allowed: false, input_tokens: 0, output_tokens: 0 })], { from: "2026-10-07", to: "2026-10-07" }, true);
    expect(out.totals.cost_usd).toBe(0);
    expect(out.pricing.unpricedModels).toEqual([]);
  });
});

describe("csvGroups", () => {
  it("makes one row per day, user, task and model", () => {
    const groups = csvGroups([row(), row({ ts: "2026-10-07T12:00:00.000Z" }), row({ model: "claude-haiku-5-5" }), row({ day: "2026-10-06", ts: "2026-10-06T01:00:00.000Z" })]);
    expect(groups.map((g) => [g.day, g.user, g.task, g.model, g.calls])).toEqual([
      ["2026-10-06", "u1", "draft.section", "claude-opus-5-5", 1],
      ["2026-10-07", "u1", "draft.section", "claude-haiku-5-5", 1],
      ["2026-10-07", "u1", "draft.section", "claude-opus-5-5", 2],
    ]);
  });
});

describe("usageFor (memory buffer)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryAudit();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads only the team's model calls in the range, and says it is memory only", async () => {
    await writeAt("2026-10-01T10:00:00Z", call());
    await writeAt("2026-10-02T23:59:59Z", call({ model: "claude-sonnet-5-5" }));
    await writeAt("2026-10-02T10:00:00Z", call({ teamId: "org:b", userId: "other" })); // another team
    await writeAt("2026-10-02T10:00:00Z", call({ action: "document_saved", task: null })); // not a model call
    await writeAt("2026-10-02T10:00:00Z", call({ teamId: null })); // no team (system work outside a request)
    await writeAt("2026-10-03T00:00:00Z", call()); // past the range
    vi.setSystemTime(NOW);
    const out = await usageFor("org:a", { from: "2026-10-01", to: "2026-10-02" });
    expect(out.memoryOnly).toBe(true);
    expect(out.totals.calls).toBe(2);
    expect(out.byUser.map((u) => u.user)).toEqual(["u1"]);
    expect(out.byModel.map((m) => m.model).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    const other = await usageFor("org:b", { from: "2026-10-01", to: "2026-10-02" });
    expect(other.totals.calls).toBe(1);
    expect(other.byUser[0].user).toBe("other");
  });

  it("falls back to args.task and result.model for entries without the columns", async () => {
    await writeAt("2026-10-02T10:00:00Z", call({ task: null, model: null, args: { task: "rubric.check" }, result: { model: "claude-sonnet-5-5", input_tokens: 5, output_tokens: 1 } }));
    vi.setSystemTime(NOW);
    const out = await usageFor("org:a", { from: "2026-10-02", to: "2026-10-02" });
    expect(out.byTask[0]).toMatchObject({ task: "rubric.check", input_tokens: 5 });
    expect(out.byModel[0].model).toBe("claude-sonnet-5-5");
  });

  it("throws a RangeError for a range it would refuse", async () => {
    await expect(usageFor("org:a", { from: "2026-10-09", to: "2026-10-01" })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("loadUsageRows (Postgres)", () => {
  beforeEach(() => {
    process.env.POSTGRES_URL = "postgres://test";
    sqlMock.query.mockReset();
    sqlMock.query.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    delete process.env.POSTGRES_URL;
  });

  it("filters by team, UTC range and llm actions, with JSON fallbacks and a row cap", async () => {
    sqlMock.query.mockImplementation(async (text: unknown) =>
      String(text).includes("FROM audit_log")
        ? {
            rows: [
              { ts: new Date("2026-10-02T10:00:00Z"), agent: "ann", action: "llm:workflow", allowed: true, user_id: "u1", task: null, model: "claude-sonnet-5-5", result: { input_tokens: "12", output_tokens: 3, cache_read_input_tokens: null } },
            ],
          }
        : { rows: [] },
    );
    const { rows, memoryOnly } = await loadUsageRows("org:a", { from: "2026-10-01", to: "2026-10-02" });
    const [text, params] = sqlMock.query.mock.calls.find((c) => String(c[0]).includes("FROM audit_log"))!;
    expect(String(text)).toMatch(/WHERE team_id = \$1 AND ts >= \$2 AND ts < \$3 AND action LIKE 'llm:%'/);
    expect(String(text)).toMatch(/COALESCE\(task, args->>'task'\)/);
    expect(String(text)).toMatch(/COALESCE\(model, result->>'model'\)/);
    expect(String(text)).toContain(`LIMIT ${MAX_USAGE_ROWS}`);
    expect(params).toEqual(["org:a", "2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z"]);
    expect(memoryOnly).toBe(false);
    expect(rows).toEqual([expect.objectContaining({ day: "2026-10-02", user: "u1", task: "workflow.node", model: "claude-sonnet-5-5", input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0 })]);
  });
});
