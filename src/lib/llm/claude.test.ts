import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

const { create, stream, write } = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn(), write: vi.fn(async () => {}) }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create, stream } };
  },
}));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write }) }));

import { claudeJson, claudeText, ModelRefusalError, ModelTruncatedError } from "./claude";

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
    create.mockResolvedValue(message("rewritten"));
    await claudeText({ task: "rewrite.selection", system: "S", user: "u", timeoutMs: 5000 });
    expect(stream).not.toHaveBeenCalled();
    expect(create.mock.calls[0][1]).toEqual({ timeout: 5000, maxRetries: 1 });
  });
});
