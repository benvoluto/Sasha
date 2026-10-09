// Phase 9 cost dashboard: the GET /api/usage contract (phase9-spec.md §3).
// Tokens and estimated cost of the current team's model calls, from audit_log,
// for a date range. Costs are estimates from src/lib/llm/pricing.ts, never a
// bill. Imported by the /usage page, so keep it free of server-only imports.

import { z } from "zod";

/** A calendar day, YYYY-MM-DD, in UTC. */
export const UsageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-01.");

/** Longest range one request may cover. */
export const USAGE_MAX_DAYS = 366;
/** Default range when the query names none: the last 30 days, today included. */
export const USAGE_DEFAULT_DAYS = 30;

/**
 * GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]. Both ends are
 * inclusive UTC days; `to` defaults to today and `from` to USAGE_DEFAULT_DAYS
 * before it. format=csv returns one row per (day, user, task, model) as
 * text/csv with a Content-Disposition attachment.
 */
export const UsageQuery = z
  .object({
    from: UsageDay.optional(),
    to: UsageDay.optional(),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "The start date must be on or before the end date." });
export type UsageQuery = z.infer<typeof UsageQuery>;

/** Token and cost sums for one group of calls. */
export type UsageTotals = {
  calls: number;
  /** Calls that failed (audit allowed = false); counted in `calls`, usually with no tokens. */
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests: number;
  /** Estimated US dollars; null when any call in the group used a model with no price. */
  cost_usd: number | null;
  /** Estimated US dollars for the calls whose model has a price: equals cost_usd when that is known, else the floor ("at least"). Groups sort on it. */
  priced_cost_usd: number;
};

export type UsageGroup<K extends string> = UsageTotals & Record<K, string>;

export type UsageResponse = {
  /** The range actually used, inclusive UTC days. */
  range: { from: string; to: string };
  totals: UsageTotals;
  /** Sorted by cost (then calls), highest first. `task` is e.g. "draft.section", "gemini.extract", "workflow.node". */
  byTask: UsageGroup<"task">[];
  byModel: UsageGroup<"model">[];
  /** `user` is the user id; `label` the audit agent (email) seen most recently for it. */
  byUser: (UsageGroup<"user"> & { label: string })[];
  /** Every day in the range, oldest first, zero-filled. */
  byDay: UsageGroup<"day">[];
  pricing: {
    /** The date the price table was last checked, YYYY-MM-DD. */
    asOf: string;
    /** Always says the figures are estimates and to check current pricing. */
    note: string;
    /** Models seen in the range with no price (their cost is left out). */
    unpricedModels: string[];
  };
  /** True when the data came from the in-memory audit buffer (no POSTGRES_URL): this process only, recent calls only. */
  memoryOnly: boolean;
};

/** CSV header for format=csv, in column order. */
export const USAGE_CSV_COLUMNS = [
  "day",
  "user",
  "label",
  "task",
  "model",
  "calls",
  "errors",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "web_search_requests",
  "cost_usd",
] as const;
