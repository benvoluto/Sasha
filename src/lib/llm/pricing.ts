// List prices for the usage dashboard's cost estimates (phase9-spec.md §3.2).
// Figures are Anthropic first-party API list prices in US dollars, from the
// claude-api reference as of PRICING_AS_OF; they are estimates, never a bill
// (negotiated rates, batch discounts and partner platforms all differ).
//
// Gemini is left unpriced: no price for GEMINI_MODEL is recorded in the repo
// or the reference, and a guessed figure would be worse than none. Its calls
// still count tokens; their cost is null and the model is listed as unpriced.

export const PRICING_AS_OF = "2026-10-06";
export const PRICING_NOTE = `Estimates from list prices as of ${PRICING_AS_OF}; check current pricing.`;

/** US dollars per web search request (server web search: $10 per 1,000). */
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

/** US dollars per million tokens. */
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type ModelPrice = Rates & {
  /** The id prefix this price matched. */
  model: string;
  /** A second rate card for long prompts (Claude Haiku 5.5): applies when the prompt has more than `aboveTokens` tokens. */
  longPrompt?: Rates & { aboveTokens: number };
};

// Cache writes are the 5-minute rate (the app only uses ephemeral 5-minute
// caching). Where the reference gives no explicit figure, cache reads are 0.1x
// input and 5-minute writes 1.25x, as it states for every model without its own rate.
const PRICES: ModelPrice[] = [
  { model: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { model: "claude-mythos-5-1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { model: "claude-fable-5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { model: "claude-mythos-5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { model: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { model: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { model: "claude-opus-4-8", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { model: "claude-opus-4-7", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { model: "claude-opus-4-6", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { model: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { model: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { model: "claude-sonnet-4-6", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  {
    model: "claude-haiku-5-5",
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  { model: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

// Longest prefix first, so "claude-opus-5-5-…" never matches "claude-opus-5".
const BY_LENGTH = [...PRICES].sort((a, b) => b.model.length - a.model.length);

/**
 * The price for a model id, matching dated or suffixed ids by prefix
 * ("claude-opus-5-5-20260901", "claude-opus-5-5[1m]"); a Bedrock-style
 * "anthropic." prefix is ignored. Null for a model with no price.
 */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.trim().toLowerCase().replace(/^anthropic\./, "");
  // The prefix must end at the id's end or a separator, so "claude-sonnet-5" does not match "claude-sonnet-55".
  return BY_LENGTH.find((p) => id === p.model || (id.startsWith(p.model) && /^[-@[:.]/.test(id.slice(p.model.length)))) ?? null;
}

export type PricedUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  web_search_requests?: number | null;
};

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Estimated US dollars for one call's usage, or null when the model has no price. */
export function costOf(model: string | null | undefined, usage: PricedUsage): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const input = n(usage.input_tokens);
  const cacheRead = n(usage.cache_read_input_tokens);
  const cacheWrite = n(usage.cache_creation_input_tokens);
  // The prompt is every input token, cached or not.
  const rates = price.longPrompt && input + cacheRead + cacheWrite > price.longPrompt.aboveTokens ? price.longPrompt : price;
  const tokens = input * rates.input + n(usage.output_tokens) * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite;
  return tokens / 1_000_000 + n(usage.web_search_requests) * WEB_SEARCH_USD_PER_REQUEST;
}
