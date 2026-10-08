import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleAuditSink, usageLine } from "./governance";

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
