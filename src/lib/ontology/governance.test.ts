import { afterEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => {
  const tag = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] }));
  const query = vi.fn(async () => ({ rows: [] }));
  return { tag, query };
});
vi.mock("@vercel/postgres", () => ({ sql: Object.assign(sqlMock.tag, { query: sqlMock.query }) }));

import { AUDIT_LOG_SCHEMA } from "./audit-schema";
import { AUDIT_BUFFER_SIZE, consoleAuditSink, defaultAuditSink, memoryAuditSink, postgresAuditSink, readMemoryAudit, resetMemoryAudit, usageLine } from "./governance";

describe("usageLine", () => {
  it("summarizes an LLM call's token usage", () => {
    expect(usageLine({ model: "claude-haiku-5-5", input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(
      "claude-haiku-5-5 in=1200 out=180",
    );
    expect(usageLine({ model: "claude-opus-5-5", input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 })).toBe("claude-opus-5-5 in=10 out=5 cached=900");
  });

  it("reports a failed call's error and ignores other results", () => {
    expect(usageLine({ error: "Claude took too long to reply." })).toBe("error: Claude took too long to reply.");
    expect(usageLine({ ok: true })).toBeNull();
    expect(usageLine(null)).toBeNull();
    expect(usageLine("text")).toBeNull();
  });
});

describe("consoleAuditSink", () => {
  afterEach(() => vi.restoreAllMocks());

  // Without POSTGRES_URL this is the only audit record, and it used to drop the usage.
  it("logs the usage of an LLM call", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await consoleAuditSink.write({ agent: "dev@localhost", action: "llm:outline.status", args: {}, result: { model: "m", input_tokens: 3, output_tokens: 4 }, allowed: true });
    expect(log).toHaveBeenCalledWith("[audit] ALLOW dev@localhost · llm:outline.status · m in=3 out=4");
  });
});

describe("defaultAuditSink without a database", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMemoryAudit();
  });

  it("keeps entries with a timestamp in the in-memory buffer, and logs them", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await defaultAuditSink().write({ agent: "ann", action: "llm:draft.section", args: {}, result: { model: "m", input_tokens: 1, output_tokens: 2 }, allowed: true, teamId: "org:a", task: "draft.section" });
    const [entry] = readMemoryAudit();
    expect(entry).toMatchObject({ agent: "ann", teamId: "org:a", task: "draft.section" });
    expect(Date.parse(entry.ts)).not.toBeNaN();
    expect(log).toHaveBeenCalled();
  });

  it("drops the oldest entries past AUDIT_BUFFER_SIZE", async () => {
    for (let i = 0; i < AUDIT_BUFFER_SIZE + 3; i++) await memoryAuditSink.write({ agent: "a", action: `n${i}`, args: {}, result: {}, allowed: true });
    const entries = readMemoryAudit();
    expect(entries).toHaveLength(AUDIT_BUFFER_SIZE);
    expect(entries[0].action).toBe("n3");
    expect(entries.at(-1)!.action).toBe(`n${AUDIT_BUFFER_SIZE + 2}`);
  });
});

describe("postgresAuditSink", () => {
  afterEach(() => {
    delete process.env.POSTGRES_URL;
    sqlMock.tag.mockClear();
    sqlMock.query.mockClear();
  });

  it("applies the Phase 9 columns once and writes them", async () => {
    process.env.POSTGRES_URL = "postgres://test";
    const entry = { agent: "ann", action: "llm:x", args: {}, result: {}, allowed: true, teamId: "org:a", userId: "u1", documentId: "d1", runId: "r1", task: "x", model: "claude-haiku-5-5", latencyMs: 12.6 };
    await postgresAuditSink.write(entry);
    await postgresAuditSink.write(entry);
    expect(sqlMock.query).toHaveBeenCalledTimes(AUDIT_LOG_SCHEMA.length);
    const [strings, ...values] = sqlMock.tag.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toMatch(/team_id, user_id, document_id, run_id, task, model, latency_ms/);
    expect(values.slice(-7)).toEqual(["org:a", "u1", "d1", "r1", "x", "claude-haiku-5-5", 13]);
  });
});
