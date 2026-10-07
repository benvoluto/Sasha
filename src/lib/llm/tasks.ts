// Which model does which job. Every model call names a task; this table maps
// the task to a model tier and an effort level. The tiers resolve to model ids
// from the environment so a deployment can move a tier without a code change.
//
// Gemini is not here: it only reads uploads (see src/lib/gemini*.ts).

export type Tier = "fast" | "mid" | "draft";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type TaskSpec = { tier: Tier; effort: Effort; maxTokens: number };

export const TASKS = {
  /** Background document-type classifier. */
  "classify.type": { tier: "fast", effort: "low", maxTokens: 2000 },
  /** Suggested sources and data. */
  "suggest.items": { tier: "fast", effort: "low", maxTokens: 4000 },
  /** Required-element status for the living outline. */
  "outline.status": { tier: "fast", effort: "low", maxTokens: 4000 },
  /** One-paragraph summary of an uploaded source. */
  "summarize.source": { tier: "fast", effort: "low", maxTokens: 2000 },
  /** A short title for a document from its first lines. */
  "title.suggest": { tier: "fast", effort: "low", maxTokens: 500 },
  /** Rubric scoring, source coverage, restructure planning, the assistant. */
  "rubric.check": { tier: "mid", effort: "medium", maxTokens: 16000 },
  "coverage.score": { tier: "mid", effort: "medium", maxTokens: 16000 },
  "restructure.plan": { tier: "mid", effort: "high", maxTokens: 16000 },
  assistant: { tier: "mid", effort: "medium", maxTokens: 16000 },
  /** Prose: drafting, rewriting, drafting from notes, applying a restructure. */
  "draft.section": { tier: "draft", effort: "medium", maxTokens: 16000 },
  "rewrite.selection": { tier: "draft", effort: "medium", maxTokens: 16000 },
  "draft.from_notes": { tier: "draft", effort: "medium", maxTokens: 16000 },
  "restructure.apply": { tier: "draft", effort: "high", maxTokens: 32000 },
} as const satisfies Record<string, TaskSpec>;

export type Task = keyof typeof TASKS;

const DEFAULT_MODELS: Record<Tier, string> = {
  fast: "claude-haiku-5-5",
  mid: "claude-sonnet-5-5",
  draft: "claude-opus-5-5",
};

const ENV_KEYS: Record<Tier, string> = {
  fast: "SASHA_MODEL_FAST",
  mid: "SASHA_MODEL_MID",
  draft: "SASHA_MODEL_DRAFT",
};

export function modelForTier(tier: Tier, env: Record<string, string | undefined> = process.env): string {
  return env[ENV_KEYS[tier]]?.trim() || DEFAULT_MODELS[tier];
}

export function resolveTask(task: Task, env: Record<string, string | undefined> = process.env) {
  const spec: TaskSpec = TASKS[task];
  return { ...spec, model: modelForTier(spec.tier, env) };
}

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`).
 * Haiku has no server-side fallback, so a refusal there is returned as is.
 */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus|sonnet|fable)-/.test(model);
}
