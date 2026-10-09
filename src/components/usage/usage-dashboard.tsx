"use client";

// The /usage page (phase9-spec.md §3.3): the team's model calls, tokens and
// estimated cost for a date range, from GET /api/usage. Totals first, then
// calls or tokens per day (chart plus table), the top tasks, models and users,
// and a CSV download of the same range. Costs are estimates from list prices,
// and the page says so next to every total.

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Download, Loader2 } from "@/components/icons";
import { AccountButton } from "@/components/shell/account-button";
import { UsageDay, USAGE_MAX_DAYS, type UsageResponse, type UsageTotals } from "@/lib/usage/contract";
import { UsageChart } from "./usage-chart";
import {
  dayLabel,
  formatCount,
  formatWhole,
  costLabel,
  isEmpty,
  newestFirst,
  presetOf,
  presetRange,
  PRESETS,
  taskLabel,
  todayUtc,
  totalTokens,
  usageUrl,
  type ChartMetric,
} from "./usage-model";

const navLink = "rounded-full px-3 py-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)]";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--doc-accent)]";
const toggle = `inline-flex min-h-11 items-center rounded-md border border-[var(--doc-line)] px-3 text-sm font-medium text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] aria-pressed:border-[var(--doc-accent)] aria-pressed:bg-[var(--doc-accent-soft)] aria-pressed:text-[var(--doc-ink)] sm:min-h-8 ${focusRing}`;
// Field boundary at 3:1 (WCAG 1.4.11), like every other text field.
const dateInput = `min-h-11 rounded-md border border-[var(--doc-field-line)] focus-visible:border-[var(--doc-accent)] bg-transparent px-2 text-sm text-[var(--doc-ink)] sm:min-h-9 ${focusRing} [color-scheme:light] dark:[color-scheme:dark]`;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: UsageResponse };

/** Why a typed range can't be asked for, or null. */
function rangeProblem(from: string, to: string): string | null {
  if (!UsageDay.safeParse(from).success || !UsageDay.safeParse(to).success) return "Enter both dates.";
  if (from > to) return "The start date must be on or before the end date.";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > USAGE_MAX_DAYS) return `Choose a range of at most ${USAGE_MAX_DAYS} days.`;
  return null;
}

export function UsageDashboard() {
  const [range, setRange] = useState(() => presetRange(30));
  const [draft, setDraft] = useState(range);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [metric, setMetric] = useState<ChartMetric>("calls");

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ state: "loading" });
    fetch(usageUrl(range), { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "Usage couldn't be loaded.");
        setLoad({ state: "ready", data: body as UsageResponse });
      })
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setLoad({ state: "error", message: error instanceof Error && error.message ? error.message : "Usage couldn't be loaded." });
      });
    return () => ctrl.abort();
  }, [range]);

  const problem = rangeProblem(draft.from, draft.to);
  const setDate = (key: "from" | "to", value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (!rangeProblem(next.from, next.to)) setRange(next);
  };
  const choosePreset = (days: number) => {
    const next = presetRange(days);
    setDraft(next);
    setRange(next);
  };
  const active = presetOf(range);
  const data = load.state === "ready" ? load.data : null;

  return (
    <div className="doc-screen min-h-screen bg-[var(--doc-bg)] text-[var(--doc-ink)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pb-6 pt-6 sm:px-10 sm:pt-8">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/" className="text-[22px] font-semibold tracking-tight">
            Sasha
          </Link>
          <nav aria-label="Sections" className="flex flex-wrap items-center gap-1 text-[15px] font-medium">
            <Link href="/" className={navLink}>
              Write
            </Link>
            <Link href="/library" className={navLink}>
              Sources
            </Link>
            <span aria-current="page" className="rounded-full bg-[var(--doc-surface)] px-3 py-1.5 text-[var(--doc-accent)] shadow-sm">
              Usage
            </span>
          </nav>
        </div>
        <div className="grid h-11 w-11 place-items-center">
          <AccountButton />
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-2 mb-10 min-h-[75vh] min-w-0 overflow-hidden rounded-2xl bg-[var(--doc-surface)] outline-none shadow-[0_1px_3px_rgba(16,24,40,0.06),0_8px_24px_rgba(16,24,40,0.05)] sm:mx-10"
      >
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-[var(--doc-line)] px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1 basis-56">
            <h1 className="text-lg font-semibold">Usage</h1>
            <p className="text-sm text-[var(--doc-muted)]">Your team&rsquo;s model calls, tokens and estimated cost. Days are in UTC.</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--doc-muted)]">
              From
              <input type="date" value={draft.from} max={draft.to || todayUtc()} onChange={(e) => setDate("from", e.target.value)} className={dateInput} aria-invalid={problem ? true : undefined} aria-describedby={problem ? "usage-range-problem" : undefined} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--doc-muted)]">
              To
              <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDate("to", e.target.value)} className={dateInput} aria-invalid={problem ? true : undefined} aria-describedby={problem ? "usage-range-problem" : undefined} />
            </label>
            <div role="group" aria-label="Quick ranges" className="flex gap-1.5">
              {PRESETS.map((d) => (
                <button key={d} type="button" aria-pressed={active === d} onClick={() => choosePreset(d)} className={toggle}>
                  {d} days
                </button>
              ))}
            </div>
            <a
              href={usageUrl(range, "csv")}
              download
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 text-sm font-semibold text-[var(--doc-on-accent)] sm:min-h-8 ${focusRing}`}
            >
              <Download className="h-4 w-4" aria-hidden="true" /> Download CSV
            </a>
          </div>
          {problem && (
            <p id="usage-range-problem" role="alert" className="w-full text-sm text-red-700 dark:text-red-300">
              {problem}
            </p>
          )}
        </div>

        <div className="space-y-8 px-4 py-5 sm:px-6">
          {load.state === "loading" && (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading usage…
            </p>
          )}
          {load.state === "error" && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {load.message}
            </p>
          )}
          {data && <Report data={data} metric={metric} onMetric={setMetric} />}
        </div>
      </main>
    </div>
  );
}

function Report({ data, metric, onMetric }: { data: UsageResponse; metric: ChartMetric; onMetric: (m: ChartMetric) => void }) {
  const range = `${dayLabel(data.range.from, true)} to ${dayLabel(data.range.to, true)}`;
  return (
    <>
      {data.memoryOnly && (
        <p role="note" className="rounded-md border border-[var(--doc-line)] bg-[var(--doc-accent-soft)] px-3 py-2 text-sm">
          No database is configured, so this shows only this server&rsquo;s recent calls since it last started.
        </p>
      )}

      <section aria-labelledby="usage-totals">
        <h2 id="usage-totals" className="sr-only">
          Totals, {range}
        </h2>
        <Totals data={data} />
      </section>

      {isEmpty(data) ? (
        <p role="status" className="text-sm text-[var(--doc-muted)]">
          No model calls between {range}.
        </p>
      ) : (
        <>
          <section aria-labelledby="usage-by-day" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="usage-by-day" className="text-base font-semibold">
                By day
              </h2>
              <div role="group" aria-label="Chart shows" className="flex gap-1.5">
                {(["calls", "tokens"] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={metric === m} onClick={() => onMetric(m)} className={toggle}>
                    {m === "calls" ? "Calls" : "Tokens"}
                  </button>
                ))}
              </div>
            </div>
            <UsageChart days={data.byDay} metric={metric} />
            {/* Always shown (it scrolls in its own region): the chart's label points screen readers here. */}
            <GroupTable caption={`Usage by day, ${range}`} label="Day" rows={newestFirst(data.byDay)} name={(g) => dayLabel(g.day, true)} />
          </section>

          <section aria-labelledby="usage-by-task" className="space-y-3">
            <h2 id="usage-by-task" className="text-base font-semibold">
              Top tasks
            </h2>
            <GroupTable caption={`Usage by task, ${range}`} label="Task" rows={data.byTask} name={(g) => taskLabel(g.task)} detail={(g) => g.task} />
          </section>

          <section aria-labelledby="usage-by-model" className="space-y-3">
            <h2 id="usage-by-model" className="text-base font-semibold">
              By model
            </h2>
            <GroupTable caption={`Usage by model, ${range}`} label="Model" rows={data.byModel} name={(g) => g.model} />
          </section>

          <section aria-labelledby="usage-by-user" className="space-y-3">
            <h2 id="usage-by-user" className="text-base font-semibold">
              By person
            </h2>
            <GroupTable caption={`Usage by person, ${range}`} label="Person" rows={data.byUser} name={(g) => g.label} detail={(g) => (g.user ? null : "Background work with no signed-in person")} />
          </section>
        </>
      )}

      <p className="border-t border-[var(--doc-line)] pt-4 text-xs text-[var(--doc-muted)]">
        {data.pricing.note} Calls from before usage tracking began (audit entries without a team) are not shown, and at most 200,000 calls are read per range.
      </p>
    </>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--doc-line)] px-4 py-3">
      <dt className="text-sm text-[var(--doc-muted)]">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
      {children && <dd className="mt-1 text-xs text-[var(--doc-muted)]">{children}</dd>}
    </div>
  );
}

function Totals({ data }: { data: UsageResponse }) {
  const t = data.totals;
  const unpriced = data.pricing.unpricedModels;
  return (
    <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-5">
      <Tile label="Estimated cost" value={costLabel(t)}>
        {unpriced.length ? `Leaves out ${unpriced.join(", ")} (no price on file). ` : ""}
        {data.pricing.note}
      </Tile>
      <Tile label="Model calls" value={formatCount(t.calls)}>
        {t.errors ? `${formatWhole(t.errors)} failed` : null}
      </Tile>
      <Tile label="Input tokens" value={formatCount(t.input_tokens)} />
      <Tile label="Output tokens" value={formatCount(t.output_tokens)} />
      <Tile label="Cached tokens" value={formatCount(t.cache_read_input_tokens + t.cache_creation_input_tokens)}>
        {formatCount(t.cache_read_input_tokens)} read, {formatCount(t.cache_creation_input_tokens)} written
        {t.web_search_requests ? `; ${formatWhole(t.web_search_requests)} web searches` : ""}
      </Tile>
    </dl>
  );
}

function GroupTable<G extends UsageTotals>({ caption, label, rows, name, detail }: { caption: string; label: string; rows: G[]; name: (g: G) => string; detail?: (g: G) => string | null }) {
  const th = "px-3 py-2 text-right font-medium whitespace-nowrap";
  const td = "px-3 py-2 text-right tabular-nums whitespace-nowrap";
  return (
    // Wide tables scroll inside their own box, never the page. Focusable so a keyboard can scroll it.
    <div role="region" aria-label={caption} tabIndex={0} className={`mt-2 max-h-[28rem] overflow-auto rounded-lg border border-[var(--doc-line)] ${focusRing}`}>
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-[var(--doc-surface)] text-[var(--doc-muted)]">
          <tr className="border-b border-[var(--doc-line)]">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {label}
            </th>
            <th scope="col" className={th}>
              Calls
            </th>
            <th scope="col" className={th}>
              Failed
            </th>
            <th scope="col" className={th}>
              Input
            </th>
            <th scope="col" className={th}>
              Output
            </th>
            <th scope="col" className={th}>
              Cached
            </th>
            <th scope="col" className={th}>
              Est. cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g, i) => {
            const note = detail?.(g);
            return (
              <tr key={i} className="border-b border-[var(--doc-line)] last:border-b-0">
                <th scope="row" className="max-w-[18rem] px-3 py-2 text-left font-normal">
                  <span className="block truncate">{name(g)}</span>
                  {note && note !== name(g) && <span className="block truncate text-xs text-[var(--doc-muted)]">{note}</span>}
                </th>
                <td className={td}>{formatWhole(g.calls)}</td>
                <td className={td}>{formatWhole(g.errors)}</td>
                <td className={td}>{formatWhole(g.input_tokens)}</td>
                <td className={td}>{formatWhole(g.output_tokens)}</td>
                <td className={td}>{formatWhole(g.cache_read_input_tokens + g.cache_creation_input_tokens)}</td>
                <td className={td}>
                  {costLabel(g)}
                  {g.cost_usd === null && totalTokens(g) > 0 && <span className="sr-only"> (no price on file)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
