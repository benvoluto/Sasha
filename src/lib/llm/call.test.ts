import { beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create } };
  },
}));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));

import { callModel } from "./call";
import { ModelChoice } from "./model-choice";

const reply = (text: string, stop_reason = "end_turn") => ({ model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason });

describe("callModel (anthropic)", () => {
  beforeEach(() => create.mockReset());

  it("asks for JSON in the system prompt and sends no temperature", async () => {
    create.mockResolvedValue(reply('{"a":1}'));
    const out = await callModel({ provider: "anthropic", model: "claude-sonnet-5-5", temperature: 0.7, system: "Extract.", user: "text" });
    expect(out).toEqual({ text: '{"a":1}', truncated: false });
    const params = create.mock.calls[0][0];
    expect(params).not.toHaveProperty("temperature");
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params.system[0].text).toMatch(/^Extract\.\n\n.*JSON object/);
  });

  it("leaves the system prompt alone for text replies and reports truncation", async () => {
    create.mockResolvedValue(reply("partial", "max_tokens"));
    const out = await callModel({ provider: "anthropic", model: "claude-sonnet-5-5", temperature: 0, system: "S", user: "u", json: false });
    expect(out.truncated).toBe(true);
    expect(create.mock.calls[0][0].system[0].text).toBe("S");
  });

  it("runs a non-Claude model id on the mid tier", async () => {
    create.mockResolvedValue(reply("ok"));
    await callModel({ provider: "anthropic", model: "gemini-2.5-flash", temperature: 0, system: "S", user: "u", json: false });
    expect(create.mock.calls[0][0].model).toBe("claude-sonnet-5-5");
  });

  it("throws on a refusal", async () => {
    create.mockResolvedValue({ ...reply(""), stop_reason: "refusal", stop_details: { category: "cyber" } });
    await expect(callModel({ provider: "anthropic", model: "claude-sonnet-5-5", temperature: 0, system: "S", user: "u" })).rejects.toThrow(/declined/);
  });
});

describe("ModelChoice", () => {
  it("reads a saved gemini provider as anthropic", () => {
    expect(ModelChoice.parse({ provider: "gemini", model: "m", temperature: 0 }).provider).toBe("anthropic");
    expect(() => ModelChoice.parse({ provider: "openai", model: "m", temperature: 0 })).toThrow();
  });
});
