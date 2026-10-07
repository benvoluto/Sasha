// Model choices for the workflow canvas's AI nodes (src/lib/workflow/registry.ts):
// which provider and model a node calls, at what temperature.

import { z } from "zod";

/**
 * anthropic: Claude through the Anthropic API (ANTHROPIC_API_KEY).
 * gateway: any model through Vercel AI Gateway (AI_GATEWAY_API_KEY), named
 * "provider/model", e.g. an OpenAI model.
 */
export const Provider = z.enum(["anthropic", "gateway"]);
export type Provider = z.infer<typeof Provider>;

/** Workflows saved before Claude replaced Gemini name provider "gemini"; read those as Claude. */
const LegacyProvider = z.preprocess((v) => (v === "gemini" ? "anthropic" : v), Provider);

export const ModelChoice = z.object({
  provider: LegacyProvider,
  model: z.string().trim().min(1),
  /** Used by the gateway only; Claude models take no sampling parameters. */
  temperature: z.number().min(0).max(2),
});
export type ModelChoice = z.infer<typeof ModelChoice>;
