import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

const governedTool = vi.fn();
vi.mock("./governance", () => ({ governedTool: (...a: unknown[]) => governedTool(...a) }));
vi.mock("./tools", async (orig) => ({ ...(await orig<typeof import("./tools")>()), loadSources: vi.fn(async () => []) }));
vi.mock("../governance", async (orig) => ({
  ...(await orig<typeof import("../governance")>()),
  defaultAuditSink: () => ({ write: vi.fn(async () => {}) }),
}));

import { runDocumentAssistant } from "./agent";

const auth = { agent: "user:test", permissions: ["source:read", "document:read"] };
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function reply(content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}) {
  return { model: "claude-sonnet-5-5", content, stop_reason, usage, ...extra };
}

function fakeClient(replies: unknown[]) {
  const create = vi.fn();
  for (const r of replies) create.mockResolvedValueOnce(r);
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}

describe("runDocumentAssistant", () => {
  beforeEach(() => governedTool.mockReset());

  it("runs a tool call through the gate and returns the final text", async () => {
    governedTool.mockResolvedValue({ documents: [{ doc_id: "g-0", name: "Budget.pdf" }] });
    const { client, create } = fakeClient([
      reply([{ type: "tool_use", id: "tu_1", name: "list_documents", input: {} }], "tool_use"),
      reply([{ type: "text", text: "There is one source: Budget.pdf." }], "end_turn"),
    ]);

    const out = await runDocumentAssistant({ groupId: "g", auth, messages: [{ role: "user", content: "What sources?" }], client });

    expect(out.answer).toBe("There is one source: Budget.pdf.");
    expect(out.trace).toEqual([{ tool: "list_documents", target: "{}", ok: true }]);
    expect(governedTool).toHaveBeenCalledWith(auth, "list_documents", {}, "g", expect.any(Function));

    const first = create.mock.calls[0][0];
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first.tool_choice).toEqual({ type: "auto" });
    expect(first).not.toHaveProperty("temperature");
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(["list_documents", "read_document", "search_text"]);

    const second = create.mock.calls[1][0];
    const last = second.messages[second.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });

  it("marks a tool error in the trace and the tool result", async () => {
    governedTool.mockResolvedValue({ error: "permission denied" });
    const { client, create } = fakeClient([
      reply([{ type: "tool_use", id: "tu_1", name: "read_document", input: { doc: "x" } }], "tool_use"),
      reply([{ type: "text", text: "Not available." }], "end_turn"),
    ]);
    const out = await runDocumentAssistant({ groupId: "g", auth, messages: [{ role: "user", content: "q" }], client });
    expect(out.trace[0]).toMatchObject({ tool: "read_document", ok: false });
    const results = create.mock.calls[1][0].messages.at(-1).content;
    expect(results[0].is_error).toBe(true);
  });

  it("reports a refusal instead of throwing", async () => {
    const { client } = fakeClient([reply([], "refusal", { stop_details: { category: "cyber" } })]);
    const out = await runDocumentAssistant({ groupId: "g", auth, messages: [{ role: "user", content: "q" }], client });
    expect(out.answer).toMatch(/declined/);
  });

  it("asks for a text answer once the tool budget is spent", async () => {
    governedTool.mockResolvedValue({ hits: [] });
    const toolTurn = reply([{ type: "tool_use", id: "tu", name: "search_text", input: { query: "x" } }], "tool_use");
    const { client, create } = fakeClient([...Array(6).fill(toolTurn), reply([{ type: "text", text: "Done." }], "end_turn")]);
    const out = await runDocumentAssistant({ groupId: "g", auth, messages: [{ role: "user", content: "q" }], client });
    expect(out.answer).toBe("Done.");
    expect(create).toHaveBeenCalledTimes(7);
    expect(create.mock.calls[6][0].tool_choice).toEqual({ type: "none" });
  });

  it("returns a diagnostic when the model call fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const client = { beta: { messages: { create } } } as unknown as Anthropic;
    const out = await runDocumentAssistant({ groupId: "g", auth, messages: [{ role: "user", content: "q" }], client });
    expect(out.answer).toMatch(/couldn't reach the model.*boom/);
  });
});
