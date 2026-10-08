'use client';

// The Run log (every run, newest first, each expandable into its steps) and the
// Overview (outcomes, errors, and step timings per workflow version), both built
// from the same list of run summaries. Runs are named by the document they read.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, RefreshCw } from '@/components/icons';
import {
  formatDuration,
  OUTCOME_LABEL,
  runDuration,
  runOutcome,
  summarizeRuns,
  type RunOutcome,
  type RunSummary,
  versionKey,
  workflowLabel,
  type StepStats,
} from '@/lib/workflow/run-stats';
import { RunTimeline } from './run-timeline';
import { Muted, OutcomeBadge } from './run-parts';
import type { DocumentOption } from './types';

const HISTORY_LIMIT = 300;
const PAGE_SIZE = 20;

export type LogFilter = { query: string; outcome: RunOutcome | ''; version: string };
export const EMPTY_FILTER: LogFilter = { query: '', outcome: '', version: '' };

export type RunHistory = {
  runs: RunSummary[];
  /** Document id to its title, for the runs' subjects. */
  documentTitles: Record<string, string>;
  persisted: boolean;
  limit: number;
  loading: boolean;
  error: string | null;
  loadedAt: Date | null;
  reload: () => void;
};

/** Loads the run list (and document titles for it) the first time `active` is true, and on reload. */
export function useRunHistory(active: boolean): RunHistory {
  const [data, setData] = useState<Omit<RunHistory, 'loading' | 'error' | 'reload'>>({ runs: [], documentTitles: {}, persisted: true, limit: HISTORY_LIMIT, loadedAt: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [history, documents] = await Promise.all([
        fetch(`/api/workflow-runs/runs/history?limit=${HISTORY_LIMIT}`, { cache: 'no-store' }).then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
          return body as { runs: RunSummary[]; persisted?: boolean; limit?: number };
        }),
        fetch('/api/documents', { cache: 'no-store' })
          .then((r) => r.json())
          .then((b: { documents?: DocumentOption[] }) => b.documents ?? [])
          .catch(() => [] as DocumentOption[]),
      ]);
      setData({
        runs: history.runs,
        persisted: history.persisted ?? true,
        limit: history.limit ?? HISTORY_LIMIT,
        documentTitles: Object.fromEntries(documents.map((d) => [d.id, d.title.trim() || 'Untitled document'])),
        loadedAt: new Date(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !data.loadedAt && !loading) reload();
  }, [active, data.loadedAt, loading, reload]);

  return { ...data, loading, error, reload };
}

/** The run's document by title; a document deleted (or archived out of the list) since reads by its id. */
const documentName = (h: RunHistory, id: string | null) => (id ? (h.documentTitles[id] ?? `Document ${id.slice(0, 8)}`) : 'No document');

function HistoryHeader({ history, children }: { history: RunHistory; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
        {history.loadedAt && `Updated ${history.loadedAt.toLocaleTimeString()}`}
        <Button variant="outline" size="sm" onClick={history.reload} disabled={history.loading}>
          {history.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
        </Button>
      </div>
    </div>
  );
}

function HistoryNotices({ history }: { history: RunHistory }) {
  return (
    <>
      {history.error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{history.error}</p>}
      {!history.persisted && (
        <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          No database is configured: this shows runs since the server last started, and audit entries go to the server console only.
        </p>
      )}
      {history.runs.length >= history.limit && <Muted>Showing the newest {history.limit} runs.</Muted>}
    </>
  );
}

// --- Run log ------------------------------------------------------------------

export function RunLog({ history, filter, setFilter }: { history: RunHistory; filter: LogFilter; setFilter: (f: LogFilter) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // Each workflow version that has runs, by workflow name then newest first.
  const versions = useMemo(
    () =>
      [...new Map(history.runs.map((r) => [versionKey(r), r])).values()].sort(
        (a, b) => a.workflow_name.localeCompare(b.workflow_name) || b.workflow_version - a.workflow_version,
      ),
    [history.runs],
  );

  const rows = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return history.runs.filter(
      (r) =>
        (!q || r.id.toLowerCase().startsWith(q) || documentName(history, r.document_id).toLowerCase().includes(q) || r.requested_by.toLowerCase().includes(q)) &&
        (!filter.outcome || runOutcome(r) === filter.outcome) &&
        (!filter.version || versionKey(r) === filter.version),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.runs, history.documentTitles, filter]);

  useEffect(() => setPage(0), [filter]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const filtered = JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);
  const select = 'h-8 rounded-md border bg-transparent px-2 text-sm dark:border-zinc-700';

  return (
    <div className="space-y-3">
      <HistoryHeader history={history}>
        <Input className="h-8 w-60" placeholder="Search documents, run ID, or person" value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} />
        <select className={select} value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value as RunOutcome | '' })} aria-label="Status">
          <option value="">Any status</option>
          {(Object.keys(OUTCOME_LABEL) as RunOutcome[]).map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>
        <select className={select} value={filter.version} onChange={(e) => setFilter({ ...filter, version: e.target.value })} aria-label="Workflow version">
          <option value="">Any workflow</option>
          {versions.map((v) => (
            <option key={versionKey(v)} value={versionKey(v)}>
              {workflowLabel(v)}
            </option>
          ))}
        </select>
        {filtered && (
          <button className="text-sm text-zinc-600 hover:underline dark:text-zinc-400" onClick={() => setFilter(EMPTY_FILTER)}>
            Reset filters
          </button>
        )}
      </HistoryHeader>
      <HistoryNotices history={history} />

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs font-semibold text-zinc-500 dark:border-zinc-800">
              <th className="px-3 py-2">Date &amp; time</th>
              <th className="px-3 py-2">Run ID</th>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Workflow</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Total time</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const expanded = open === r.id;
              return (
                <Fragment key={r.id}>
                  <tr
                    className={`cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${expanded ? 'bg-zinc-50 dark:bg-zinc-800/50' : ''}`}
                    onClick={() => setOpen(expanded ? null : r.id)}
                    aria-expanded={expanded}
                  >
                    <td className="whitespace-nowrap px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400" title={r.id}>
                      {r.id.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2">{documentName(history, r.document_id)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{workflowLabel(r)}</td>
                    <td className="px-3 py-2">
                      <OutcomeBadge outcome={runOutcome(r)} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatDuration(runDuration(r))}</td>
                    <td className="px-2 py-2 text-zinc-500">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/30">
                      <td colSpan={7} className="px-6 py-4">
                        <div className="mb-3 text-xs text-zinc-500">
                          Run {r.id} · started by {r.requested_by}
                          {r.status === 'superseded' ? ' · replaced by a later run of this workflow on the document' : ''}
                        </div>
                        <RunTimeline run={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-zinc-500">
                  {history.loading ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : filtered ? 'No runs match these filters.' : 'No runs yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <div className="flex items-center justify-between text-sm text-zinc-600 dark:text-zinc-400">
          <span>
            {page * PAGE_SIZE + 1}–{Math.min(rows.length, (page + 1) * PAGE_SIZE)} of {rows.length}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              {page + 1} / {pages}
            </span>
            <Button variant="ghost" size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Overview -----------------------------------------------------------------

const RANGES = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: 'all', label: 'All loaded runs', days: null },
] as const;

const OUTCOME_FILL: Record<RunOutcome, string> = {
  complete: 'bg-emerald-500',
  failed: 'bg-red-500',
  awaiting_review: 'bg-violet-500',
  paused: 'bg-amber-500',
  running: 'bg-sky-500',
  stopped: 'bg-zinc-400',
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');

function Tile({ label, value, sub, onClick, tone }: { label: string; value: string; sub?: string; onClick?: () => void; tone?: 'bad' | 'warn' }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={`rounded-lg border border-zinc-200 bg-white p-4 text-left dark:border-zinc-800 dark:bg-zinc-900 ${onClick ? 'transition hover:border-zinc-400 dark:hover:border-zinc-600' : ''}`}
    >
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'bad' ? 'text-red-700 dark:text-red-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </Comp>
  );
}

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Horizontal bars, one per row, scaled to the largest value. */
function Bars({ rows, onClick }: { rows: Array<{ key: string; label: string; value: number; fill: string; display?: string }>; onClick?: (key: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key}>
          <button className="grid w-full grid-cols-[9rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-left text-sm disabled:cursor-default" disabled={!onClick} onClick={() => onClick?.(r.key)} title={`${r.label}: ${r.display ?? r.value}`}>
            <span className="truncate text-zinc-700 dark:text-zinc-300">{r.label}</span>
            <span className="h-3 rounded-r-[4px] bg-zinc-100 dark:bg-zinc-800">
              <span className={`block h-3 rounded-r-[4px] ${r.fill}`} style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.display ?? r.value}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One step's spread: a track from 0 to the slowest step's max, the min–max range, and a tick at the average. */
function RangeBar({ s, scale }: { s: StepStats; scale: number }) {
  const at = (v: number) => `${(v / scale) * 100}%`;
  return (
    <div className="relative h-3 w-full rounded-[4px] bg-zinc-100 dark:bg-zinc-800" title={`min ${formatDuration(s.min)} · avg ${formatDuration(s.avg)} · max ${formatDuration(s.max)}`}>
      <div className="absolute inset-y-0 rounded-[4px] bg-sky-200 dark:bg-sky-900" style={{ left: at(s.min), width: `calc(${at(s.max - s.min)} + 2px)` }} />
      <div className="absolute inset-y-[-2px] w-[3px] rounded bg-sky-700 dark:bg-sky-300" style={{ left: `calc(${at(s.avg)} - 1px)` }} />
    </div>
  );
}

function VersionCard({ v, onFailed }: { v: ReturnType<typeof summarizeRuns>['versions'][number]; onFailed: () => void }) {
  const longest = v.steps[0];
  const shortest = v.steps.at(-1);
  const scale = Math.max(1, ...v.steps.map((s) => s.max));
  return (
    <Card
      title={v.label}
      aside={
        <span className="text-xs text-zinc-500">
          {v.runs} run{v.runs === 1 ? '' : 's'} · {v.results} complete ·{' '}
          <button className={v.failed ? 'text-red-700 hover:underline dark:text-red-400' : ''} onClick={onFailed} disabled={!v.failed}>
            {v.failed} failed
          </button>{' '}
          · avg run {formatDuration(v.avgRun)}
        </span>
      }
    >
      {v.steps.length ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
              <div className="text-xs text-zinc-500">Longest step (average)</div>
              <div className="font-medium">{longest.label}</div>
              <div className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">{formatDuration(longest.avg)} · up to {formatDuration(longest.max)}</div>
            </div>
            {shortest && shortest !== longest && (
              <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <div className="text-xs text-zinc-500">Shortest step (average)</div>
                <div className="font-medium">{shortest.label}</div>
                <div className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">{formatDuration(shortest.avg)} · as fast as {formatDuration(shortest.min)}</div>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-zinc-500">
                  <th className="py-1 pr-3">Step</th>
                  <th className="py-1 pr-3 text-right">Runs</th>
                  <th className="py-1 pr-3 text-right">Failed</th>
                  <th className="py-1 pr-3 text-right">Min</th>
                  <th className="py-1 pr-3 text-right">Avg</th>
                  <th className="py-1 pr-3 text-right">Max</th>
                  <th className="w-1/3 py-1">Spread</th>
                </tr>
              </thead>
              <tbody>
                {v.steps.map((s) => (
                  <tr key={s.nodeId} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1.5 pr-3">{s.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.runs}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${s.failed ? 'text-red-700 dark:text-red-400' : 'text-zinc-500'}`}>{s.failed}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatDuration(s.min)}</td>
                    <td className="py-1.5 pr-3 text-right font-medium tabular-nums">{formatDuration(s.avg)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatDuration(s.max)}</td>
                    <td className="py-1.5">
                      <RangeBar s={s} scale={scale} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">Bar: the shaded range runs from fastest to slowest; the tick marks the average. Human checkpoints are left out, since they time the reviewer.</p>
        </>
      ) : (
        <Muted>No step in this version has finished yet.</Muted>
      )}
    </Card>
  );
}

export function RunsOverview({ history, openLog }: { history: RunHistory; openLog: (f: Partial<LogFilter>) => void }) {
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30');
  const runs = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)?.days;
    if (!days) return history.runs;
    const since = Date.now() - days * 86_400_000;
    return history.runs.filter((r) => new Date(r.created_at).getTime() >= since);
  }, [history.runs, range]);
  const o = useMemo(() => summarizeRuns(runs), [runs]);
  const finished = o.total - o.byOutcome.running;
  const durations = runs.map(runDuration).filter((d): d is number => d !== null);
  const avgRun = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const outcomes = (Object.keys(OUTCOME_LABEL) as RunOutcome[]).filter((k) => o.byOutcome[k] > 0);

  return (
    <div className="space-y-4">
      <HistoryHeader history={history}>
        <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`rounded px-2.5 py-1 text-sm ${range === r.key ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
            >
              {r.label}
            </button>
          ))}
        </div>
      </HistoryHeader>
      <HistoryNotices history={history} />

      {history.loading && !history.loadedAt ? (
        <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      ) : !o.total ? (
        <Card title="No runs in this period">
          <Muted>Run a workflow on a document from the Editor tab or the document&apos;s Workflows tab, or widen the time range.</Muted>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Runs" value={String(o.total)} sub={o.byOutcome.running ? `${o.byOutcome.running} running now` : undefined} onClick={() => openLog({})} />
            <Tile label="Complete" value={String(o.byOutcome.complete)} sub={`${pct(o.byOutcome.complete, finished)} of finished runs`} onClick={() => openLog({ outcome: 'complete' })} />
            <Tile label="Failed" value={String(o.byOutcome.failed)} sub={`${pct(o.byOutcome.failed, finished)} of finished runs`} tone={o.byOutcome.failed ? 'bad' : undefined} onClick={() => openLog({ outcome: 'failed' })} />
            <Tile label="Average run time" value={formatDuration(avgRun)} sub="start to finish, including review waits" />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card title="Outcomes">
              <div className="flex h-3 gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={outcomes.map((k) => `${OUTCOME_LABEL[k]} ${o.byOutcome[k]}`).join(', ')}>
                {outcomes.map((k) => (
                  <span key={k} className={OUTCOME_FILL[k]} style={{ flexGrow: o.byOutcome[k] }} title={`${OUTCOME_LABEL[k]}: ${o.byOutcome[k]}`} />
                ))}
              </div>
              <Bars rows={outcomes.map((k) => ({ key: k, label: OUTCOME_LABEL[k], value: o.byOutcome[k], fill: OUTCOME_FILL[k] }))} onClick={(k) => openLog({ outcome: k as RunOutcome })} />
            </Card>
            <Card title="Most common errors">
              {o.topErrors.length ? (
                <ul className="space-y-2 text-sm">
                  {o.topErrors.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-red-700 dark:text-red-400">{e.count}×</span>
                      <span>
                        <span className="font-medium">{e.label}</span>: <span className="text-zinc-600 dark:text-zinc-400">{e.error}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Muted>No step failed in this period.</Muted>
              )}
            </Card>
          </div>

          <h2 className="pt-2 text-base font-semibold">Step timings by workflow version</h2>
          {o.versions.map((v) => (
            <VersionCard key={v.key} v={v} onFailed={() => openLog({ outcome: 'failed', version: v.key })} />
          ))}
        </>
      )}
    </div>
  );
}
