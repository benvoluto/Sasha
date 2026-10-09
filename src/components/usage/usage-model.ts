// Pure helpers for the /usage page: date presets, the API query string,
// number formatting and the chart's scale. Kept apart from the components so
// they can be tested without a DOM.

import type { UsageResponse, UsageTotals } from "@/lib/usage/contract";

export const PRESETS = [7, 30, 90] as const;
export type Preset = (typeof PRESETS)[number];

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Today as a UTC day (the API's days are UTC). */
export const todayUtc = (now = Date.now()) => dayOf(now);

/** The last `days` days, today included. */
export function presetRange(days: number, now = Date.now()): { from: string; to: string } {
  const to = todayUtc(now);
  return { from: dayOf(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS), to };
}

/** The preset a range matches (ending today), or null. */
export function presetOf(range: { from: string; to: string }, now = Date.now()): Preset | null {
  return PRESETS.find((d) => {
    const p = presetRange(d, now);
    return p.from === range.from && p.to === range.to;
  }) ?? null;
}

/** The /api/usage URL for a range, optionally as CSV. */
export function usageUrl(range: { from: string; to: string }, format: "json" | "csv" = "json"): string {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  if (format === "csv") q.set("format", "csv");
  return `/api/usage?${q}`;
}

const whole = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 1,284 below ten thousand, then 12.9K / 4.2M. */
export function formatCount(n: number): string {
  return Math.abs(n) < 10_000 ? whole.format(n) : compact.format(n);
}

/** Every digit, thousands-comma'd (tables). */
export const formatWhole = (n: number) => whole.format(n);

/**
 * Estimated dollars: "$0.0042" under a cent, up to four places under a dollar
 * ("$0.0125", "$0.50"), "$1.23" otherwise; "—" when unknown. Two places under a
 * dollar showed a $0.0125 draft as "$0.01" beside a $0.0087 one at full precision.
 */
export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The day table's rows, newest first (a copy). The response and the chart run
 * oldest first, but the table scrolls in its own box, so oldest first put today
 * below 29 rows of zeros on the default range.
 */
export const newestFirst = <T extends { day: string }>(days: T[]): T[] => [...days].sort((a, b) => b.day.localeCompare(a.day));

/** Input, output and cache tokens together. */
export const totalTokens = (t: Pick<UsageTotals, "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">) =>
  t.input_tokens + t.output_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens;

/**
 * A group's cost as the page shows it. The response leaves cost_usd null when
 * any call in the group used a model with no price (Gemini); then the priced
 * part is a floor ("At least $1.23"), or "—" when nothing in it had a price.
 */
export function costLabel(t: Pick<UsageTotals, "cost_usd" | "priced_cost_usd">): string {
  if (t.cost_usd !== null) return formatCost(t.cost_usd);
  return t.priced_cost_usd > 0 ? `At least ${formatCost(t.priced_cost_usd)}` : formatCost(null);
}

/** "draft.section" → "Draft section"; "gemini.extract" → "Gemini extract". */
export function taskLabel(task: string): string {
  const s = task.replace(/[._-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
}

/** "2026-10-07" → "Oct 7" (UTC, so the label is the same day the API counted). */
export function dayLabel(day: string, withYear = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** A clean axis maximum at or above `max` (1, 2, 2.5 or 5 times a power of ten), and its ticks from 0. */
export function niceScale(max: number, ticks = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return { max: top, ticks: out };
}

export type ChartMetric = "calls" | "tokens";

/** The chart's value for a day. */
export const metricValue = (d: UsageTotals, metric: ChartMetric) => (metric === "calls" ? d.calls : totalTokens(d));

/** True when nothing was called in the range. */
export const isEmpty = (r: UsageResponse) => r.totals.calls === 0;
