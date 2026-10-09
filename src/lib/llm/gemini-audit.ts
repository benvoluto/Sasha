// Audit rows for Gemini calls (phase9-spec.md §3.1), so uploads and table
// reads show up in the usage dashboard beside Claude's tasks. One row per
// generateContent attempt: action "llm:gemini.<kind>", task "gemini.<kind>",
// tokens from the reply's usageMetadata, and the team, user and document from
// the current model context (context.ts). Never throws: a failed audit write
// must not fail the read it describes.

import { defaultAuditSink } from "@/lib/ontology/governance";
import { currentModelContext } from "./context";

export type GeminiKind = "extract" | "tables";

/** The parts of Gemini's usageMetadata the audit reads (the SDK's GenerateContentResponseUsageMetadata). */
export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
};

/**
 * Gemini's usage in the audit result's shape (the same keys as Claude's). Thinking tokens bill as output.
 * Gemini's promptTokenCount includes the cached tokens, while Claude's input_tokens excludes cache reads,
 * so the cached part is taken out of input_tokens to keep the two disjoint.
 */
export function geminiUsage(model: string, usage: GeminiUsageMetadata | null | undefined) {
  const cached = usage?.cachedContentTokenCount ?? 0;
  return {
    model,
    input_tokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cached),
    output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export async function auditGemini(e: { kind: GeminiKind; model: string; usage: GeminiUsageMetadata | null | undefined; error?: unknown; latencyMs: number; label?: string }): Promise<void> {
  const ctx = currentModelContext();
  const task = `gemini.${e.kind}`;
  const usage = geminiUsage(e.model, e.usage);
  try {
    await defaultAuditSink().write({
      agent: ctx?.agent ?? "system",
      action: `llm:${task}`,
      args: { task, documentId: ctx?.documentId ?? null, ...(e.label ? { label: e.label } : {}) },
      result: e.error ? { ...(e.usage ? usage : { model: e.model }), error: e.error instanceof Error ? e.error.message : String(e.error) } : usage,
      allowed: !e.error,
      teamId: ctx?.teamId ?? null,
      userId: ctx?.userId ?? null,
      documentId: ctx?.documentId ?? null,
      runId: ctx?.runId ?? null,
      task,
      model: e.model,
      latencyMs: Math.max(0, Math.round(e.latencyMs)),
    });
  } catch (error) {
    console.error("[llm] Gemini audit write failed:", error);
  }
}

/**
 * Run one generateContent call and audit it, success or failure. Wrap the
 * call itself (inside any retry helper), so each attempt is a row.
 */
export async function auditedGenerate<T extends { usageMetadata?: GeminiUsageMetadata | null }>(kind: GeminiKind, model: string, call: () => Promise<T>, label?: string): Promise<T> {
  const started = Date.now();
  try {
    const response = await call();
    await auditGemini({ kind, model, usage: response.usageMetadata ?? null, latencyMs: Date.now() - started, label });
    return response;
  } catch (error) {
    await auditGemini({ kind, model, usage: null, error, latencyMs: Date.now() - started, label });
    throw error;
  }
}

/** Rough token counts for an e2e stub reply (about four characters a token), so the dashboard has Gemini rows in e2e runs. */
export function stubGeminiUsage(input: string, output: string): GeminiUsageMetadata {
  return { promptTokenCount: Math.max(1, Math.ceil(input.length / 4)), candidatesTokenCount: Math.max(1, Math.ceil(output.length / 4)) };
}
