'use client';

// The side panel during and after a run: what the selected node produced, and,
// at a human checkpoint, the review form that continues the run.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Play } from '@/components/icons';
import { NODE_SPEC_INDEX, OUTPUT_NODE_TYPE } from '@/lib/workflow/registry';
import { runOutcome, toRunSummary } from '@/lib/workflow/run-stats';
import type { GraphNode } from '@/lib/workflow/types';
import { RunTimeline } from './run-timeline';
import { Muted, OutcomeBadge, Section, StepStatus } from './run-parts';
import type { WorkflowRun } from './types';

function ValueView({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <Muted>(empty)</Muted>;
  if (typeof value === 'string') return <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{value}</pre>;
  if (Array.isArray(value)) {
    return (
      <ol className="list-decimal space-y-2 pl-5">
        {value.map((v, i) => (
          <li key={i}>
            <ValueView value={v} />
          </li>
        ))}
      </ol>
    );
  }
  return <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{JSON.stringify(value, null, 2)}</pre>;
}

/** Short description of a checkpoint item, for the review checklist. */
function itemSummary(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function CheckpointReview({ run, node, onContinue }: { run: WorkflowRun; node: GraphNode; onContinue: (excluded: number[], note: string) => Promise<void> }) {
  const items = (run.outputs[node.id]?.pending_items as unknown[]) ?? [];
  const [excluded, setExcluded] = useState<number[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 rounded-lg border border-violet-300 bg-violet-50 p-3 dark:border-violet-800 dark:bg-violet-950/40">
      <p className="text-sm font-medium">This run is waiting for you.</p>
      {node.config.instructions ? <Muted>{String(node.config.instructions)}</Muted> : null}
      <ul className="space-y-2">
        {items.map((v, i) => (
          <li key={i}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={!excluded.includes(i)} onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== i) : [...excluded, i])} />
              <span>{itemSummary(v)}</span>
            </label>
          </li>
        ))}
        {!items.length && <Muted>Nothing reached this checkpoint.</Muted>}
      </ul>
      <Textarea className="text-sm" placeholder="Note for later steps (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onContinue(excluded, note);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Play />} Continue run{excluded.length ? ` without ${excluded.length} item${excluded.length === 1 ? '' : 's'}` : ''}
      </Button>
    </div>
  );
}

/** What the Save output node recorded as the run's result. */
function RunResult({ run }: { run: WorkflowRun }) {
  const node = run.workflow.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  if (!node || run.steps[node.id]?.status !== 'done') return null;
  const result = run.outputs[node.id]?.result;
  if (typeof result !== 'string' || !result.trim()) return <Muted>The run finished, but nothing reached Save output.</Muted>;
  return (
    <Section title="Result">
      <ValueView value={result} />
    </Section>
  );
}

export function RunInspector({
  run,
  node,
  canRun,
  onContinue,
  onSelectNode,
}: {
  run: WorkflowRun;
  node: GraphNode | null;
  canRun: boolean;
  onContinue: (checkpoint?: { nodeId: string; excluded: number[]; note: string }) => Promise<void>;
  onSelectNode: (nodeId: string) => void;
}) {
  const summary = toRunSummary(run);

  if (!node) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Run result</h2>
          <OutcomeBadge outcome={runOutcome(summary)} />
        </div>
        <Muted>Click a node to see what it produced.</Muted>
        {run.status === 'paused' && canRun && (
          <Button size="sm" onClick={() => onContinue()}>
            <Play /> Continue run
          </Button>
        )}
        <RunResult run={run} />
        <Section title="Run log">
          <RunTimeline run={summary} onSelectNode={onSelectNode} />
        </Section>
      </div>
    );
  }

  const spec = NODE_SPEC_INDEX[node.type];
  const state = run.steps[node.id];
  const outputs = run.outputs[node.id];
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500">{spec?.label}</div>
        <h2 className="text-lg font-semibold">{node.label || spec?.label}</h2>
      </div>
      {state ? <StepStatus state={state} /> : <Muted>This node was not part of the run (the workflow changed since).</Muted>}
      {state?.status === 'waiting' && canRun && <CheckpointReview run={run} node={node} onContinue={(excluded, note) => onContinue({ nodeId: node.id, excluded, note })} />}
      {run.checkpoints[node.id] && (
        <Muted>
          Continued by {run.checkpoints[node.id].by}
          {run.checkpoints[node.id].excluded.length ? `, leaving out ${run.checkpoints[node.id].excluded.length} item(s)` : ''}
          {run.checkpoints[node.id].note ? `: “${run.checkpoints[node.id].note}”` : ''}
        </Muted>
      )}
      {node.type === OUTPUT_NODE_TYPE && state && state.status !== 'done' && state.status !== 'running' && (
        <Muted>No result was saved. {summary.nodes.filter((n) => run.steps[n.id]?.status === 'failed').map((n) => n.label).join(', ') || 'An earlier step'} did not finish; see the run log.</Muted>
      )}
      {outputs && state?.status !== 'waiting' &&
        Object.entries(outputs).map(([port, value]) => (
          <Section key={port} title={port.replace(/_/g, ' ')}>
            <ValueView value={value} />
          </Section>
        ))}
      {run.raw[node.id] && (
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-600">Show the reply that failed validation</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{run.raw[node.id]}</pre>
        </details>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Run log</summary>
        <div className="mt-2">
          <RunTimeline run={summary} onSelectNode={onSelectNode} />
        </div>
      </details>
    </div>
  );
}
