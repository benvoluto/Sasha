// The document assistant's model-driven loop: open-ended questions with no
// fixed tool order. A manual Claude tool-use loop (task "assistant", see
// src/lib/llm/tasks.ts), with every tool call going through the read-only,
// audited choke point. The model reads the sources and explains; it never writes.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { defaultAuditSink, type Auth } from "../governance";
import type { SourceDocument } from "@/lib/sources/passages";
import { claudeConfigured } from "@/lib/llm/claude";
import { resolveTask, supportsServerFallback } from "@/lib/llm/tasks";
import { renderMenu } from "./menu";
import { governedTool } from "./governance";
import { ASSISTANT_TOOLS, loadSources } from "./tools";

export type AssistantMessage = { role: "user" | "assistant"; content: string };
export type ToolTraceEntry = { tool: string; target: string; ok: boolean };

const MAX_STEPS = 6;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const PERSONA = `You are a writing assistant for one document. You help the user
understand the source files uploaded to it and plan or improve their writing.

Rules:
- Answer only from what you read via your tools. If a tool returns nothing or an
  error, say the information isn't available. Do not guess.
- Start with list_documents when you don't yet know what sources exist; use
  search_text to find specific facts and read_document to read around them.
- Name the source file you are relying on when you state a fact.
- Be concise.`;

const TOOLS: BetaTool[] = Object.values(ASSISTANT_TOOLS).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: {
    type: "object",
    properties: Object.fromEntries(Object.entries(t.params).map(([k, d]) => [k, { type: "string", description: d }])),
    required: t.required,
  },
}));

let defaultClient: Anthropic | null = null;
function anthropic(): Anthropic {
  defaultClient ??= new Anthropic();
  return defaultClient;
}

function errDetail(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

function textOf(message: BetaMessage): string {
  return message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/** The conversation as Claude messages; it must open with a user turn. */
function toClaudeMessages(messages: AssistantMessage[]): BetaMessageParam[] {
  const first = messages.findIndex((m) => m.role === "user");
  return (first < 0 ? [] : messages.slice(first)).map((m) => ({ role: m.role, content: m.content }));
}

export async function runDocumentAssistant(input: {
  groupId: string;
  auth: Auth;
  messages: AssistantMessage[];
  /** For tests; defaults to a shared client that reads ANTHROPIC_API_KEY. */
  client?: Anthropic;
}): Promise<{ answer: string; trace: ToolTraceEntry[] }> {
  if (!input.client && !claudeConfigured()) {
    return { answer: "The assistant is unavailable (no model API key configured).", trace: [] };
  }
  const client = input.client ?? anthropic();
  const { model, effort, maxTokens } = resolveTask("assistant");
  const fallback = supportsServerFallback(model);

  const system = `${PERSONA}\n\n${renderMenu(input.auth)}\n\n(The document is fixed; all tools operate on its sources.)`;
  const messages = toClaudeMessages(input.messages);
  const trace: ToolTraceEntry[] = [];
  const usage = { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, steps: 0 };
  // Load the group's sources at most once per turn, however many tools run.
  let cached: Promise<SourceDocument[]> | null = null;
  const sources = () => (cached ??= loadSources(input.groupId));

  const call = async (finalTurn: boolean): Promise<BetaMessage> => {
    const message = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      betas: fallback ? [FALLBACK_BETA] : [],
      ...(fallback ? { fallbacks: "default" as const } : {}),
      output_config: { effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      // Out of tool budget: keep the tools defined (the history holds tool calls)
      // but ask for a text answer.
      tool_choice: finalTurn ? { type: "none" } : { type: "auto" },
      messages,
    });
    usage.model = message.model;
    usage.steps++;
    usage.input_tokens += message.usage.input_tokens;
    usage.output_tokens += message.usage.output_tokens;
    usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0;
    return message;
  };

  const finish = async (answer: string, error?: string) => {
    try {
      await defaultAuditSink().write({
        agent: input.auth.agent,
        action: "llm:assistant",
        args: { task: "assistant", group_id: input.groupId },
        result: error ? { error, ...usage } : usage,
        allowed: !error,
        groupId: input.groupId,
      });
    } catch (e) {
      console.error("[assistant] audit write failed:", e);
    }
    return { answer, trace };
  };

  try {
    for (let step = 0; step <= MAX_STEPS; step++) {
      const finalTurn = step === MAX_STEPS;
      const response = await call(finalTurn);

      if (response.stop_reason === "refusal") {
        return finish("The assistant declined to answer that request.", `refusal:${response.stop_details?.category ?? "unknown"}`);
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      const calls = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason === "max_tokens") {
        // Never run a tool call that may have been cut off.
        const text = textOf(response);
        return finish(text || "The answer was too long to finish. Please ask a narrower question.", "max_tokens");
      }
      if (calls.length === 0 || finalTurn) {
        const fallbackText = finalTurn
          ? "I read the sources but couldn't compose an answer. Please rephrase."
          : "I couldn't find enough in the sources to answer that.";
        return finish(textOf(response) || fallbackText);
      }

      // Keep the model's turn as it came back, then execute each call through
      // the audited, read-only choke point and return every result in one message.
      messages.push({ role: "assistant", content: response.content });
      const results: BetaToolResultBlockParam[] = [];
      for (const c of calls) {
        const args = c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {};
        const target = JSON.stringify(args).slice(0, 120);
        let out: unknown;
        try {
          out = await governedTool(input.auth, c.name, args, input.groupId, sources);
        } catch (error) {
          // A tool failure must not crash the turn; report it to the model.
          console.error(`[assistant] tool '${c.name}' ${target} failed:`, error);
          out = { error: "tool execution failed" };
        }
        const ok = !!out && typeof out === "object" && !("error" in out);
        trace.push({ tool: c.name, target, ok });
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out ?? null), ...(ok ? {} : { is_error: true }) });
      }
      messages.push({ role: "user", content: results });
    }
    return finish("I read the sources but couldn't compose an answer. Please rephrase.");
  } catch (error) {
    const detail = errDetail(error);
    console.error(`[assistant] model call failed: ${detail}`);
    return finish(`The assistant couldn't reach the model right now. Please try again shortly. (diagnostic: ${detail})`, detail);
  }
}
