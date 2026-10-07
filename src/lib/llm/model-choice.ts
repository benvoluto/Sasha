// Model choices for the workflow canvas's AI nodes (src/lib/workflow/registry.ts):
// which provider and model a node calls, at what temperature.

import { z } from "zod";

/**
 * gemini: the app's existing Google key (GEMINI_API_KEY).
 * gateway: any model through Vercel AI Gateway (AI_GATEWAY_API_KEY), named
 * "provider/model", e.g. an Anthropic or OpenAI model.
 */
export const Provider = z.enum(["gemini", "gateway"]);
export type Provider = z.infer<typeof Provider>;

export const ModelChoice = z.object({
  provider: Provider,
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2),
});
export type ModelChoice = z.infer<typeof ModelChoice>;
