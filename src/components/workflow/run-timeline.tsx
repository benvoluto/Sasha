'use client';

// A run as a list of events: when it started, each step's result and timing,
// checkpoint decisions, how it ended, and the audit log's record of it.

import { useState } from 'react';
import { CheckCircle2, CircleMinus, Clock, Hourglass, Info, Loader2, XCircle } from '@/components/icons';
import { runTimeline, type RunSummary, type TimelineEntry } from '@/lib/workflow/run-stats';
import { Muted } from './run-parts';

const ENTRY_ICON: Record<TimelineEntry['status'], { Icon: typeof Info; className: string }> = {
  ok: { Icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400' },
  failed: { Icon: XCircle, className: 'text-red-600 dark:text-red-400' },
  skipped: { Icon: CircleMinus, className: 'text-zinc-400' },
  waiting: { Icon: Hourglass, className: 'text-violet-600 dark:text-violet-400' },
  running: { Icon: Loader2, className: 'animate-spin text-sky-600 dark:text-sky-400' },
  info: { Icon: Clock, className: 'text-zinc-500' },
};

type AuditEntry = { ts: string; agent: string; action: string; allowed: boolean; note: string };

function AuditTrail({ runId }: { runId: string }) {
  const [state, setState] = useState<{ events: AuditEntry[]; persisted: boolean } | 'loading' | string | null>(null);
  // Reloaded on every open: a running run keeps adding entries.
  const load = async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/workflow-runs/runs/${runId}/events`, { cache: 'no-store' });
      const body = await res.json();
      setState(res.ok ? body : body.error || `Request failed (${res.status})`);
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="text-sm" onToggle={(e) => (e.currentTarget.open ? load() : undefined)}>
      <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Audit log entries</summary>
      <div className="mt-2">
        {state === 'loading' && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
        {typeof state === 'string' && state !== 'loading' && <p className="text-red-600 dark:text-red-400">{state}</p>}
        {state && typeof state === 'object' &&
          (state.events.length ? (
            <ul className="space-y-1 font-mono text-xs">
              {state.events.map((e, i) => (
                <li key={i} className="text-zinc-700 dark:text-zinc-300">
                  <span className="text-zinc-500">{new Date(e.ts).toLocaleString()}</span> {e.allowed ? 'ALLOW' : 'DENY'} {e.agent} · {e.action}
                  {e.note ? ` · ${e.note}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <Muted>{state.persisted ? 'No audit entries for this run.' : 'No database is configured, so audit entries go to the server console only.'}</Muted>
          ))}
      </div>
    </details>
  );
}

export function RunTimeline({ run, onSelectNode, audit = true }: { run: RunSummary; onSelectNode?: (nodeId: string) => void; audit?: boolean }) {
  const entries = runTimeline(run);
  return (
    <div className="space-y-2">
      <ol className="relative space-y-2 border-l border-zinc-200 pl-4 dark:border-zinc-700">
        {entries.map((e, i) => {
          const { Icon, className } = ENTRY_ICON[e.status];
          const title = e.nodeId && onSelectNode ? (
            <button className="text-left font-medium hover:underline" onClick={() => onSelectNode(e.nodeId!)}>
              {e.title}
            </button>
          ) : (
            <span className="font-medium">{e.title}</span>
          );
          return (
            <li key={i} className="relative text-sm">
              <span className="absolute -left-[25px] top-0.5 rounded-full bg-white dark:bg-zinc-900">
                <Icon className={`h-4 w-4 ${className}`} weight="fill" />
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2">
                {title}
                <span className="text-xs text-zinc-500">{new Date(e.at).toLocaleTimeString()}</span>
              </div>
              {e.detail && <div className={`text-xs ${e.status === 'failed' ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}>{e.detail}</div>}
            </li>
          );
        })}
      </ol>
      {audit && <AuditTrail runId={run.id} />}
    </div>
  );
}
