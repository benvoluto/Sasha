// Model calls that must return validated JSON, with one repair attempt.

import { callModel, type ModelReply } from "@/lib/llm/call";
import type { ModelChoice } from "@/lib/llm/model-choice";
import { withTimeout } from "@/lib/processing-status";

/** Per model call. */
export const CALL_TIMEOUT_MS = 120_000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The JSON object in a model reply, tolerating code fences and text around it. Throws when there is none. */
export function coerceJson(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : input).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("response contains no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Call a model and parse its reply. If the reply does not parse, the model is
 * shown the error (or told it was cut off) and asked once more.
 */
export async function callForJson<T>(
  choice: ModelChoice,
  system: string,
  user: string,
  parse: (text: string) => Parsed<T>,
  label: string,
): Promise<{ value?: T; text: string; error?: string }> {
  let reply: ModelReply = await withTimeout(callModel({ ...choice, system, user }), CALL_TIMEOUT_MS, label);
  let parsed = parse(reply.text);
  if (!parsed.ok) {
    const why = reply.truncated ? "Your reply was cut off at the output limit; answer more concisely." : `Your reply was invalid: ${parsed.error}`;
    reply = await withTimeout(callModel({ ...choice, system, user: `${user}\n\n${why}\nReturn ONLY the corrected JSON object.` }), CALL_TIMEOUT_MS, `${label} (retry)`);
    parsed = parse(reply.text);
  }
  return parsed.ok ? { value: parsed.value, text: reply.text } : { text: reply.text, error: reply.truncated ? "reply truncated at the output limit" : parsed.error };
}

/** A plain-text reply. */
export async function callForText(choice: ModelChoice, system: string, user: string, label: string): Promise<string> {
  const reply = await withTimeout(callModel({ ...choice, system, user, json: false }), CALL_TIMEOUT_MS, label);
  if (reply.truncated) throw new Error("reply truncated at the output limit");
  return reply.text.trim();
}
