// One entry point for model calls, over two providers: the app's
// Gemini key, or Vercel AI Gateway (OpenAI-compatible API) for any other model.
// Truncation is reported rather than silently returning partial JSON.

import { GoogleGenAI } from "@google/genai";
import type { ModelChoice } from "./model-choice";

export type ModelCall = ModelChoice & {
  system: string;
  user: string;
  maxOutputTokens?: number;
  /** Ask for a JSON reply (Gemini's JSON mode). Defaults to true. */
  json?: boolean;
};
export type ModelReply = { text: string; truncated: boolean };

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 16000;

async function callGemini(c: ModelCall): Promise<ModelReply> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: c.model,
    contents: c.user,
    config: {
      systemInstruction: c.system,
      temperature: c.temperature,
      maxOutputTokens: c.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      ...(c.json === false ? {} : { responseMimeType: "application/json" }),
    },
  });
  return { text: res.text ?? "", truncated: res.candidates?.[0]?.finishReason === "MAX_TOKENS" };
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
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`AI Gateway ${res.status}: ${body.error?.message ?? "request failed"}`);
  const choice = body.choices?.[0];
  return { text: choice?.message?.content ?? "", truncated: choice?.finish_reason === "length" };
}

export async function callModel(c: ModelCall): Promise<ModelReply> {
  return c.provider === "gateway" ? callGateway(c) : callGemini(c);
}
