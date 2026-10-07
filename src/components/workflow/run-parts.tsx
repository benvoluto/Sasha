'use client';

// Small shared pieces of the run views: section headings, muted text, a step's
// status, and a run's outcome badge.

import { Check, CheckCircle2, CircleMinus, Hourglass, Loader2, PauseCircle, XCircle } from '@/components/icons';
import { formatDuration, OUTCOME_LABEL, stepDuration, type RunOutcome } from '@/lib/workflow/run-stats';
import type { StepState } from './types';

export const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
    {children}
  </section>
);

export const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-zinc-600 dark:text-zinc-400">{children}</p>;

const STEP_TONE: Record<StepState['status'], string> = {
  done: 'bg-emerald-50 dark:bg-emerald-950/40',
  failed: 'bg-red-50 dark:bg-red-950/40',
  waiting: 'bg-violet-50 dark:bg-violet-950/40',
  running: 'bg-sky-50 dark:bg-sky-950/40',
  skipped: 'bg-zinc-100 dark:bg-zinc-800',
  pending: 'bg-zinc-100 dark:bg-zinc-800',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString();

export function StepStatus({ state }: { state?: StepState }) {
  if (!state) return null;
  const d = stepDuration(state);
  return (
    <div className={`space-y-1 rounded-md px-3 py-2 text-sm ${STEP_TONE[state.status]}`}>
      <div>
        <span className="font-medium capitalize">{state.status}</span>
        {state.note ? <span className="text-zinc-600 dark:text-zinc-400"> · {state.note}</span> : null}
      </div>
      {(state.startedAt || state.finishedAt) && (
        <div className="text-xs text-zinc-600 dark:text-zinc-400">
          {state.startedAt ? `Started ${time(state.startedAt)}` : ''}
          {state.finishedAt ? `${state.startedAt ? ' · ' : ''}${state.status === 'skipped' ? 'Skipped' : 'Finished'} ${time(state.finishedAt)}` : ''}
          {d !== null ? ` (${formatDuration(d)})` : ''}
        </div>
      )}
      {state.error ? <div className="text-red-700 dark:text-red-400">{state.error}</div> : null}
    </div>
  );
}

const OUTCOME_STYLE: Record<RunOutcome, { className: string; Icon: typeof Check }> = {
  draft: { className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', Icon: CheckCircle2 },
  failed: { className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', Icon: XCircle },
  awaiting_review: { className: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300', Icon: Hourglass },
  paused: { className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', Icon: PauseCircle },
  running: { className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', Icon: Loader2 },
  stopped: { className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300', Icon: CircleMinus },
};

/** A run's outcome as a labeled chip; the icon and label carry it, not the color alone. */
export function OutcomeBadge({ outcome }: { outcome: RunOutcome }) {
  const { className, Icon } = OUTCOME_STYLE[outcome];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${className}`}>
      <Icon className={`h-3.5 w-3.5 ${outcome === 'running' ? 'animate-spin' : ''}`} weight="bold" />
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}
