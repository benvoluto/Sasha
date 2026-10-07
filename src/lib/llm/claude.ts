// Claude calls for Sasha's tasks. Each call names a task (src/lib/llm/tasks.ts),
// which picks the model and effort. Opus and Sonnet calls opt into the
// server-side refusal fallback, so a declined request is retried on Anthropic's
// recommended model instead of failing. Token usage is written to the audit log.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z from "zod/v4";
import { defaultAuditSink } from "@/lib/ontology/governance";
import { resolveTask, supportsServerFallback, type Task } from "./tasks";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ClaudeInput = {
  task: Task;
  /** Stable instructions. Cached, so keep per-request values out of it. */
  system: string;
  /** The request: document text, selection, notes. */
  user: string;
  /** Who asked, for the audit log. */
  agent?: string;
  documentId?: string;
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
  const { model, effort, maxTokens } = resolveTask(input.task);
  const fallback = supportsServerFallback(model);
  return {
    model,
    fallback,
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
  const { params } = requestBase(input);
  try {
    const message = await anthropic().beta.messages.create(params);
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

/** A reply validated against a zod schema (structured tasks). */
export async function claudeJson<S extends z.ZodType>(
  input: ClaudeInput & { schema: S },
): Promise<{ data: z.infer<S>; usage: ClaudeUsage }> {
  const { params } = requestBase(input);
  try {
    const message = await anthropic().beta.messages.parse({
      ...params,
      output_config: { ...params.output_config, format: betaZodOutputFormat(input.schema) },
    });
    checkStop(message);
    if (message.parsed_output == null) throw new Error("The model's reply did not match the expected format.");
    const usage = usageOf(message);
    await audit(input, usage);
    return { data: message.parsed_output as z.infer<S>, usage };
  } catch (error) {
    await audit(input, null, error);
    throw error;
  }
}

export function claudeConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
