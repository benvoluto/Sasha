// One entry point for the workflow nodes' model calls, over two providers:
// Claude through the Anthropic API, or Vercel AI Gateway (OpenAI-compatible API)
// for any other model. Truncation is reported rather than silently returning
// partial JSON. Every call, successful or not, is written to the audit log with
// its token usage, as claude.ts does for the editor's tasks.

import Anthropic from "@anthropic-ai/sdk";
import { defaultAuditSink } from "@/lib/ontology/governance";
import { ModelRefusalError } from "./claude";
import type { ModelChoice } from "./model-choice";
import { modelForTier, supportsServerFallback } from "./tasks";

export type ModelCall = ModelChoice & {
  system: string;
  user: string;
  maxOutputTokens?: number;
  /** Ask for a JSON reply. Defaults to true. */
  json?: boolean;
  /** For the audit log: which workflow node made the call, and for whom. */
  label?: string;
  agent?: string;
};
export type ModelUsage = { input_tokens: number; output_tokens: number };
export type ModelReply = { text: string; truncated: boolean; model: string; usage: ModelUsage | null };

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 16000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Just under the workflow's per-call timeout (model-json.ts), so a hung request is aborted rather than left running. */
const REQUEST_TIMEOUT_MS = 115_000;

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic();
  return anthropicClient;
}

const JSON_INSTRUCTION = "Reply with a single JSON object and nothing else: no prose and no code fences.";

/**
 * Claude via the Anthropic API. Temperature is not sent (current Claude models
 * reject sampling parameters). A model id that is not a Claude model (e.g. one
 * left over from a Gemini-era workflow) runs on the mid tier.
 */
async function callAnthropic(c: ModelCall, model: string): Promise<ModelReply> {
  const fallback = supportsServerFallback(model);
  const system = c.json === false ? c.system : `${c.system}\n\n${JSON_INSTRUCTION}`;
  const message = await anthropic().beta.messages.create(
    {
      model,
      max_tokens: c.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      betas: fallback ? [FALLBACK_BETA] : [],
      ...(fallback ? { fallbacks: "default" as const } : {}),
      output_config: { effort: "medium" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: c.user }],
    },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 },
  );
  if (message.stop_reason === "refusal") throw new ModelRefusalError(message.stop_details?.category ?? null);
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return {
    text,
    truncated: message.stop_reason === "max_tokens",
    model: message.model,
    usage: message.usage ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } : null,
  };
}

async function callGateway(c: ModelCall): Promise<ModelReply> {
  // On Vercel, the deployment's OIDC token also authenticates to the gateway.
  const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is not set");
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: c.model,
      temperature: c.temperature,
      max_tokens: c.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: "system", content: c.system },
        { role: "user", content: c.user },
      ],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    model?: string;
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`AI Gateway ${res.status}: ${body.error?.message ?? "request failed"}`);
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    truncated: choice?.finish_reason === "length",
    model: body.model ?? c.model,
    usage: body.usage ? { input_tokens: body.usage.prompt_tokens ?? 0, output_tokens: body.usage.completion_tokens ?? 0 } : null,
  };
}

async function audit(c: ModelCall, model: string, reply: ModelReply | null, error?: unknown) {
  try {
    await defaultAuditSink().write({
      agent: c.agent ?? "system",
      action: "llm:workflow",
      args: { provider: c.provider, node: c.label ?? null, json: c.json !== false },
      result: reply
        ? { model: reply.model, ...(reply.usage ?? {}), truncated: reply.truncated }
        : { model, error: error instanceof Error ? error.message : String(error) },
      allowed: !error,
    });
  } catch (e) {
    console.error("[llm] audit write failed:", e);
  }
}

export async function callModel(c: ModelCall): Promise<ModelReply> {
  const gateway = c.provider === "gateway";
  const model = gateway || c.model.startsWith("claude-") ? c.model : modelForTier("mid");
  try {
    const reply = gateway ? await callGateway(c) : await callAnthropic(c, model);
    await audit(c, model, reply);
    return reply;
  } catch (error) {
    await audit(c, model, null, error);
    throw error;
  }
}
