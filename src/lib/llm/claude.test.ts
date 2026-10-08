import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

const { create, stream, write } = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn(), write: vi.fn(async () => {}) }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create, stream } };
  },
}));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write }) }));

import { CLAUDE_STREAM_DEADLINE_MS, claudeJson, claudeSearch, claudeText, MAX_SEARCH_CONTINUATIONS, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "./claude";

const message = (text: string, stop_reason = "end_turn", extra: Record<string, unknown> = {}) => ({
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

const schema = z.object({ summary: z.string() });
const json = (overrides: Partial<Parameters<typeof claudeJson>[0]> = {}) =>
  claudeJson({ task: "summarize.source", system: "S", user: "u", schema, ...overrides });

describe("claudeJson", () => {
  beforeEach(() => {
    create.mockReset();
    stream.mockReset();
    write.mockClear();
  });

  it("parses a valid reply, sends the schema without the parser, and sets a timeout with one retry", async () => {
    create.mockResolvedValue(message('{"summary":"ok"}'));
    const out = await json();
    expect(out.data).toEqual({ summary: "ok" });
    const [params, opts] = create.mock.calls[0];
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format).not.toHaveProperty("parse");
    expect(params.betas).toContain("structured-outputs-2025-12-15");
    expect(opts).toEqual({ timeout: expect.any(Number), maxRetries: 1 });
  });

  it("surfaces a cut-off reply as ModelTruncatedError, not a parse failure", async () => {
    create.mockResolvedValue(message('{"summary":"hal', "max_tokens"));
    await expect(json()).rejects.toBeInstanceOf(ModelTruncatedError);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
  });

  it("surfaces a refusal as ModelRefusalError", async () => {
    create.mockResolvedValue(message("", "refusal", { stop_details: { category: "cyber" } }));
    await expect(json()).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("reports a reply that does not match the schema", async () => {
    create.mockResolvedValue(message('{"other":1}'));
    await expect(json()).rejects.toThrow(/expected format/);
  });
});

describe("claudeText", () => {
  beforeEach(() => {
    create.mockReset();
    stream.mockReset();
  });

  it("streams tasks whose max_tokens is too large for a non-streaming request", async () => {
    stream.mockReturnValue({ finalMessage: async () => message("done") });
    const out = await claudeText({ task: "restructure.apply", system: "S", user: "u" });
    expect(out.text).toBe("done");
    expect(create).not.toHaveBeenCalled();
    expect(stream.mock.calls[0][0].max_tokens).toBe(32000);
  });

  it("uses a plain request for ordinary tasks", async () => {
    create.mockResolvedValue(message("checked"));
    await claudeText({ task: "rubric.check", system: "S", user: "u", timeoutMs: 5000 });
    expect(stream).not.toHaveBeenCalled();
    expect(create.mock.calls[0][1]).toEqual({ timeout: 5000, maxRetries: 1 });
  });

  it("streams draft-tier prose with an overall deadline, so a long reply isn't cut off at the request timeout", async () => {
    stream.mockReturnValue({ finalMessage: async () => message("A section.") });
    for (const task of ["draft.section", "rewrite.section", "rewrite.selection", "draft.from_notes"] as const) {
      stream.mockClear();
      await claudeText({ task, system: "S", user: "u" });
      expect(create).not.toHaveBeenCalled();
      const opts = stream.mock.calls[0][1];
      expect(opts).toMatchObject({ timeout: expect.any(Number), maxRetries: 1 });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
    expect(CLAUDE_STREAM_DEADLINE_MS).toBeLessThan(300_000);
  });

  it("reports a streamed call that runs past its deadline", async () => {
    stream.mockImplementation((_body: unknown, opts: { signal: AbortSignal }) => ({
      finalMessage: () =>
        new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")))),
    }));
    await expect(claudeText({ task: "draft.section", system: "S", user: "u", deadlineMs: 10 })).rejects.toBeInstanceOf(ModelDeadlineError);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
  });
});

describe("claudeSearch", () => {
  const tools = [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 2, allowed_domains: ["ed.gov"] }];
  const resources = z.object({ resources: z.array(z.object({ url: z.string() })) });
  const searchResult = (url: string) => ({ type: "web_search_tool_result", tool_use_id: "t", content: [{ type: "web_search_result", url, title: "T", encrypted_content: "e", page_age: null }] });
  const turn = (content: unknown[], stop_reason: string, searches = 1) => ({ model: "claude-sonnet-5-5", content, stop_reason, usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } } });

  beforeEach(() => {
    create.mockReset();
    stream.mockReset();
    write.mockClear();
  });

  it("resumes a paused turn by sending the reply back, collects searched URLs and counts searches", async () => {
    const paused = [{ type: "server_tool_use", id: "t", name: "web_search", input: { query: "q" } }, searchResult("https://www.ed.gov/a")];
    create
      .mockResolvedValueOnce(turn(paused, "pause_turn"))
      .mockResolvedValueOnce(turn([searchResult("https://www.ed.gov/b"), { type: "text", text: 'Found: {"resources":[{"url":"https://www.ed.gov/b"}]}' }], "end_turn"));
    const out = await claudeSearch({ task: "web.find", system: "S", user: "find", schema: resources, tools, agent: "a@b.c", documentId: "d1" });
    expect(out.data).toEqual({ resources: [{ url: "https://www.ed.gov/b" }] });
    expect(out.searchedUrls).toEqual(["https://www.ed.gov/a", "https://www.ed.gov/b"]);
    expect(out.usage).toMatchObject({ input_tokens: 20, output_tokens: 10, web_search_requests: 2 });
    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(first.tools).toEqual(tools);
    expect(first.output_config).not.toHaveProperty("format");
    expect(second.messages).toEqual([{ role: "user", content: "find" }, { role: "assistant", content: paused }]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ action: "llm:web.find", allowed: true, result: expect.objectContaining({ web_search_requests: 2 }) }));
  });

  it("stops resuming after MAX_SEARCH_CONTINUATIONS and repairs an unparseable reply with one tool-free claudeJson call", async () => {
    create.mockImplementation(async (params: { tools?: unknown; output_config: { format?: unknown } }) =>
      params.output_config.format ? message('{"resources":[]}') : turn([{ type: "text", text: "still searching" }], "pause_turn"),
    );
    const out = await claudeSearch({ task: "web.find", system: "S", user: "find", schema: resources, tools });
    expect(out.data).toEqual({ resources: [] });
    const calls = create.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => c.tools)).toHaveLength(1 + MAX_SEARCH_CONTINUATIONS);
    const repair = calls[calls.length - 1];
    expect(repair.tools).toBeUndefined();
    expect(repair.messages[0].content).toContain("<reply>\nstill searching\n</reply>");
  });

  it("treats a refusal like any call", async () => {
    create.mockResolvedValue({ ...turn([], "refusal"), stop_details: { category: "cyber" } });
    await expect(claudeSearch({ task: "web.find", system: "S", user: "u", schema: resources, tools })).rejects.toBeInstanceOf(ModelRefusalError);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
  });
});
