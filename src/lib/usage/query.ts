// The usage dashboard's numbers (phase9-spec.md §3.3): a team's model calls
// from audit_log for a date range, summed by task, model, user and day, with
// costs estimated from src/lib/llm/pricing.ts.
//
// Only rows with the team's team_id count, so rows written before Phase 9
// (no team_id) never appear. Older Phase 9 rows that lack a column fall back
// to their JSON (args.task, result.model). Rows are summed here rather than in
// SQL: a team's calls per range are modest, and pricing lives in code. At most
// MAX_USAGE_ROWS rows are read per request; past that the sums are partial.
//
// Without POSTGRES_URL the in-memory audit buffer (governance.ts) is read
// instead: this process's most recent calls only (memoryOnly: true).

import { sql } from "@vercel/postgres";
import { AUDIT_LOG_SCHEMA } from "@/lib/ontology/audit-schema";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { readMemoryAudit } from "@/lib/ontology/governance";
import { costOf, priceFor, PRICING_AS_OF, PRICING_NOTE } from "@/lib/llm/pricing";
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, type UsageGroup, type UsageQuery, type UsageResponse, type UsageTotals } from "./contract";

/** Rows read per request at most (see the file header). */
export const MAX_USAGE_ROWS = 200_000;

const DAY_MS = 86_400_000;

/** One model call, as the sums need it. */
export type UsageRow = {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** ISO timestamp, for picking the latest label per user. */
  ts: string;
  /** The user id, or "" when the call had none (system work). */
  user: string;
  /** The audit agent (usually an email). */
  label: string;
  task: string;
  model: string;
  allowed: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests: number;
};

// --- Range ---------------------------------------------------------------------------

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
const realDay = (day: string) => Number.isFinite(msOf(day)) && dayOf(msOf(day)) === day;

/**
 * The inclusive UTC day range a query asks for, or an error message: `to`
 * defaults to today and `from` to USAGE_DEFAULT_DAYS days ending at `to`.
 */
export function resolveRange(query: Pick<UsageQuery, "from" | "to">, now = Date.now()): { from: string; to: string } | { error: string } {
  for (const d of [query.from, query.to]) if (d && !realDay(d)) return { error: `${d} is not a real date.` };
  const to = query.to ?? dayOf(now);
  const from = query.from ?? dayOf(msOf(to) - (USAGE_DEFAULT_DAYS - 1) * DAY_MS);
  if (from > to) return { error: "The start date must be on or before the end date." };
  if ((msOf(to) - msOf(from)) / DAY_MS + 1 > USAGE_MAX_DAYS) return { error: `Choose a range of at most ${USAGE_MAX_DAYS} days.` };
  return { from, to };
}

/** Every day from `from` to `to`, inclusive. */
export function daysIn(range: { from: string; to: string }): string[] {
  const out: string[] = [];
  for (let t = msOf(range.from); t <= msOf(range.to); t += DAY_MS) out.push(dayOf(t));
  return out;
}

// --- Loading -------------------------------------------------------------------------

const num = (v: unknown) => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The task for a row without a task column or args.task (older workflow rows). */
const taskFromAction = (action: string) => (action === "llm:workflow" ? "workflow.node" : action.replace(/^llm:/, ""));

function toRow(r: { ts: string | Date; agent?: unknown; action: string; allowed?: unknown; user_id?: unknown; task?: unknown; model?: unknown; result?: unknown }): UsageRow {
  const result = obj(r.result);
  const ts = new Date(r.ts).toISOString();
  return {
    day: ts.slice(0, 10),
    ts,
    user: typeof r.user_id === "string" ? r.user_id : "",
    label: typeof r.agent === "string" && r.agent ? r.agent : "system",
    task: typeof r.task === "string" && r.task ? r.task : taskFromAction(r.action),
    model: typeof r.model === "string" && r.model ? r.model : typeof result.model === "string" && result.model ? result.model : "unknown",
    allowed: r.allowed !== false,
    input_tokens: num(result.input_tokens),
    output_tokens: num(result.output_tokens),
    cache_read_input_tokens: num(result.cache_read_input_tokens),
    cache_creation_input_tokens: num(result.cache_creation_input_tokens),
    web_search_requests: num(result.web_search_requests),
  };
}

/** The team's model calls in the range, oldest first. */
export async function loadUsageRows(teamId: string, range: { from: string; to: string }): Promise<{ rows: UsageRow[]; memoryOnly: boolean }> {
  const start = `${range.from}T00:00:00.000Z`;
  const end = new Date(msOf(range.to) + DAY_MS).toISOString();
  if (!process.env.POSTGRES_URL) {
    const rows = readMemoryAudit()
      .filter((e) => e.teamId === teamId && e.action.startsWith("llm:") && e.ts >= start && e.ts < end)
      .map((e) => toRow({ ts: e.ts, agent: e.agent, action: e.action, allowed: e.allowed, user_id: e.userId, task: e.task ?? obj(e.args).task, model: e.model, result: e.result }));
    return { rows, memoryOnly: true };
  }
  await ensureSchema("audit_log", AUDIT_LOG_SCHEMA);
  // The token fields only, not the whole result (an error message can be long).
  const { rows } = await sql.query(
    `SELECT ts, agent, action, allowed, user_id,
            COALESCE(task, args->>'task') AS task,
            COALESCE(model, result->>'model') AS model,
            jsonb_build_object(
              'input_tokens', result->'input_tokens',
              'output_tokens', result->'output_tokens',
              'cache_read_input_tokens', result->'cache_read_input_tokens',
              'cache_creation_input_tokens', result->'cache_creation_input_tokens',
              'web_search_requests', result->'web_search_requests') AS result
       FROM audit_log
      WHERE team_id = $1 AND ts >= $2 AND ts < $3 AND action LIKE 'llm:%'
      ORDER BY ts ASC
      LIMIT ${MAX_USAGE_ROWS}`,
    [teamId, start, end],
  );
  return { rows: rows.map((r) => toRow(r as Parameters<typeof toRow>[0])), memoryOnly: false };
}

// --- Sums ----------------------------------------------------------------------------

const emptyTotals = (): UsageTotals => ({
  calls: 0,
  errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  web_search_requests: 0,
  cost_usd: 0,
  priced_cost_usd: 0,
});

const hasTokens = (r: UsageRow) => r.input_tokens + r.output_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens + r.web_search_requests > 0;

/** A row's estimated cost: 0 when it used nothing, null when its model has no price. */
export function rowCost(r: UsageRow): number | null {
  return hasTokens(r) ? costOf(r.model, r) : 0;
}

function add(t: UsageTotals, r: UsageRow): void {
  t.calls += 1;
  if (!r.allowed) t.errors += 1;
  t.input_tokens += r.input_tokens;
  t.output_tokens += r.output_tokens;
  t.cache_read_input_tokens += r.cache_read_input_tokens;
  t.cache_creation_input_tokens += r.cache_creation_input_tokens;
  t.web_search_requests += r.web_search_requests;
  const cost = rowCost(r);
  // One unpriced call makes the group's cost unknown (the contract's rule).
  t.cost_usd = t.cost_usd === null || cost === null ? null : t.cost_usd + cost;
  t.priced_cost_usd += cost ?? 0;
}

/** Rounds a cost to a hundredth of a cent, so float noise doesn't show. */
const round = (usd: number) => Math.round(usd * 10_000) / 10_000;
const tidy = (t: UsageTotals): UsageTotals => ({ ...t, cost_usd: t.cost_usd === null ? null : round(t.cost_usd), priced_cost_usd: round(t.priced_cost_usd) });

function groupBy<K extends string>(rows: UsageRow[], key: K, keyOf: (r: UsageRow) => string): Array<UsageGroup<K>> {
  const map = new Map<string, UsageTotals>();
  for (const r of rows) {
    const k = keyOf(r);
    let t = map.get(k);
    if (!t) map.set(k, (t = emptyTotals()));
    add(t, r);
  }
  return [...map].map(([k, t]) => ({ ...tidy(t), [key]: k }) as UsageGroup<K>);
}

/** Highest priced cost first (so one unpriced Gemini read doesn't sink a big spender), then most calls, then by name. */
function byCost<T extends UsageTotals>(name: (g: T) => string) {
  return (a: T, b: T) => b.priced_cost_usd - a.priced_cost_usd || b.calls - a.calls || name(a).localeCompare(name(b));
}

/** The dashboard's response for rows already loaded and filtered to the range. */
export function summarize(rows: UsageRow[], range: { from: string; to: string }, memoryOnly: boolean): UsageResponse {
  const totals = emptyTotals();
  for (const r of rows) add(totals, r);

  const latestLabel = new Map<string, { ts: string; label: string }>();
  for (const r of rows) {
    const seen = latestLabel.get(r.user);
    if (!seen || r.ts >= seen.ts) latestLabel.set(r.user, { ts: r.ts, label: r.label });
  }

  const perDay = new Map(groupBy(rows, "day", (r) => r.day).map((g) => [g.day, g]));
  const unpriced = new Set<string>();
  for (const r of rows) if (hasTokens(r) && !priceFor(r.model)) unpriced.add(r.model);

  return {
    range,
    totals: tidy(totals),
    byTask: groupBy(rows, "task", (r) => r.task).sort(byCost((g) => g.task)),
    byModel: groupBy(rows, "model", (r) => r.model).sort(byCost((g) => g.model)),
    byUser: groupBy(rows, "user", (r) => r.user)
      .map((g) => ({ ...g, label: latestLabel.get(g.user)?.label ?? "system" }))
      .sort(byCost((g) => g.label)),
    byDay: daysIn(range).map((day) => perDay.get(day) ?? { ...emptyTotals(), day }),
    pricing: { asOf: PRICING_AS_OF, note: PRICING_NOTE, unpricedModels: [...unpriced].sort() },
    memoryOnly,
  };
}

/** One row per (day, user, task, model), for the CSV download, ordered by day then user, task and model. */
export function csvGroups(rows: UsageRow[]): Array<UsageGroup<"day" | "user" | "task" | "model"> & { label: string }> {
  const map = new Map<string, { key: { day: string; user: string; task: string; model: string }; label: string; ts: string; totals: UsageTotals }>();
  for (const r of rows) {
    const k = [r.day, r.user, r.task, r.model].join("\u0000");
    let g = map.get(k);
    if (!g) map.set(k, (g = { key: { day: r.day, user: r.user, task: r.task, model: r.model }, label: r.label, ts: r.ts, totals: emptyTotals() }));
    if (r.ts >= g.ts) Object.assign(g, { label: r.label, ts: r.ts });
    add(g.totals, r);
  }
  return [...map.values()]
    .map((g) => ({ ...tidy(g.totals), ...g.key, label: g.label }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.user.localeCompare(b.user) || a.task.localeCompare(b.task) || a.model.localeCompare(b.model));
}

/** The team's usage for a query. Throws a RangeError for a range resolveRange refuses (the route checks first). */
export async function usageFor(teamId: string, query: Pick<UsageQuery, "from" | "to">): Promise<UsageResponse> {
  const range = resolveRange(query);
  if ("error" in range) throw new RangeError(range.error);
  const { rows, memoryOnly } = await loadUsageRows(teamId, range);
  return summarize(rows, range, memoryOnly);
}
