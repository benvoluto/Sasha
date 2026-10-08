// Claude calls for Sasha's tasks. Each call names a task (src/lib/llm/tasks.ts),
// which picks the model and effort. Opus and Sonnet calls opt into the
// server-side refusal fallback, so a declined request is retried on Anthropic's
// recommended model instead of failing. Token usage is written to the audit log.
//
// Each request has its own timeout and at most one retry, so a slow or hung
// call fails inside the route's time budget and the caller's catch (and the
// audit write) still runs. Long prose (the draft tier, or a reply too large for
// a plain request) streams: the timeout then covers only the wait for the
// reply to start, so a long reply that is still arriving is not cut off and
// replayed, and an overall deadline bounds the whole call instead.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type * as z from "zod/v4";
import { defaultAuditSink } from "@/lib/ontology/governance";
import { resolveTask, supportsServerFallback, type Task } from "./tasks";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const STRUCTURED_BETA = "structured-outputs-2025-12-15";
/** Per request; two attempts plus the retry backoff fit a 300s function. */
export const CLAUDE_REQUEST_TIMEOUT_MS = 120_000;
/**
 * Above this the request streams. The SDK refuses a non-streaming request
 * whose max_tokens could take over 10 minutes (about 21k tokens), and a long
 * idle connection is more likely to be dropped anyway.
 */
const STREAM_ABOVE_TOKENS = 16_000;
/**
 * The whole of a streamed call, retries included. It fits a 300s function with
 * room for the work before the call (loading the document and its grounding),
 * the audit write and the response, and is not retried: a reply that
 * ran this long would run as long again.
 */
export const CLAUDE_STREAM_DEADLINE_MS = 270_000;

export type ClaudeInput = {
  task: Task;
  /** Stable instructions. Cached, so keep per-request values out of it. */
  system: string;
  /** The request: document text, selection, notes. */
  user: string;
  /** Who asked, for the audit log. */
  agent?: string;
  documentId?: string;
  /** Per-request timeout; defaults to CLAUDE_REQUEST_TIMEOUT_MS. For a streamed call it covers the wait for the reply to start. */
  timeoutMs?: number;
  /** Streamed calls only: the limit on the whole call; defaults to CLAUDE_STREAM_DEADLINE_MS. */
  deadlineMs?: number;
};

export type ClaudeUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export class ModelRefusalError extends Error {
  constructor(public category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}.`);
  }
}

export class ModelTruncatedError extends Error {
  constructor() {
    super("The model's reply was cut off before it finished.");
  }
}

function requestBase(input: ClaudeInput) {
  const { model, effort, maxTokens, tier } = resolveTask(input.task);
  const fallback = supportsServerFallback(model);
  return {
    model,
    fallback,
    stream: tier === "draft" || maxTokens > STREAM_ABOVE_TOKENS,
    params: {
      model,
      max_tokens: maxTokens,
      betas: fallback ? [FALLBACK_BETA] : [],
      ...(fallback ? { fallbacks: "default" as const } : {}),
      output_config: { effort },
      system: [{ type: "text" as const, text: input.system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: input.user }],
    },
  };
}

type Params = ReturnType<typeof requestBase>["params"] & { output_config: Record<string, unknown> };

export class ModelDeadlineError extends Error {
  constructor() {
    super("Claude took too long to reply.");
  }
}

/** Send one request, streaming when the reply may be long (see the file header). */
async function send(input: ClaudeInput, params: Params, stream: boolean): Promise<BetaMessage> {
  const opts = { timeout: input.timeoutMs ?? CLAUDE_REQUEST_TIMEOUT_MS, maxRetries: 1 };
  const body = params as MessageCreateParamsNonStreaming;
  if (!stream) return anthropic().beta.messages.create(body, opts);
  const signal = AbortSignal.timeout(input.deadlineMs ?? CLAUDE_STREAM_DEADLINE_MS);
  try {
    return await anthropic().beta.messages.stream(body, { ...opts, signal }).finalMessage();
  } catch (error) {
    if (signal.aborted) throw new ModelDeadlineError();
    throw error;
  }
}

type FinishedMessage = {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};

function checkStop(message: FinishedMessage) {
  if (message.stop_reason === "refusal") throw new ModelRefusalError(message.stop_details?.category ?? null);
  if (message.stop_reason === "max_tokens") throw new ModelTruncatedError();
}

function usageOf(message: FinishedMessage): ClaudeUsage {
  return {
    model: message.model,
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

async function audit(input: ClaudeInput, usage: ClaudeUsage | null, error?: unknown) {
  try {
    await defaultAuditSink().write({
      agent: input.agent ?? "system",
      action: `llm:${input.task}`,
      args: { task: input.task, documentId: input.documentId ?? null },
      result: usage ?? { error: error instanceof Error ? error.message : String(error) },
      allowed: !error,
    });
  } catch (e) {
    console.error("[llm] audit write failed:", e);
  }
}

/** A plain-text reply (prose tasks). */
export async function claudeText(input: ClaudeInput): Promise<{ text: string; usage: ClaudeUsage }> {
  const { params, stream } = requestBase(input);
  try {
    const message = await send(input, params, stream);
    checkStop(message);
    const text = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    const usage = usageOf(message);
    await audit(input, usage);
    return { text, usage };
  } catch (error) {
    await audit(input, null, error);
    throw error;
  }
}

/**
 * A reply validated against a zod schema (structured tasks). The stop reason is
 * checked before the reply is parsed, so a refusal or a cut-off reply surfaces
 * as ModelRefusalError / ModelTruncatedError rather than a parse failure.
 */
export async function claudeJson<S extends z.ZodType>(
  input: ClaudeInput & { schema: S },
): Promise<{ data: z.infer<S>; usage: ClaudeUsage }> {
  const { params, stream } = requestBase(input);
  // Send only the schema: the SDK's own parse step (messages.parse, or the
  // stream's final message) would throw on a truncated reply before we could
  // look at the stop reason.
  const { parse, ...format } = betaZodOutputFormat(input.schema);
  try {
    const message = await send(input, {
      ...params,
      betas: [...params.betas, STRUCTURED_BETA],
      output_config: { ...params.output_config, format },
    }, stream);
    checkStop(message);
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let data: z.infer<S>;
    try {
      data = parse(text) as z.infer<S>;
    } catch {
      throw new Error("The model's reply did not match the expected format.");
    }
    const usage = usageOf(message);
    await audit(input, usage);
    return { data, usage };
  } catch (error) {
    await audit(input, null, error);
    throw error;
  }
}

export function claudeConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
