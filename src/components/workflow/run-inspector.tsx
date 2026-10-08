'use client';

// The side panel during and after a run: what the selected node produced, and,
// at a human checkpoint, the same checkpoint panel as the document's
// Workflows tab (checkpoint-panel.tsx), which continues the run.

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Play } from '@/components/icons';
import { signatureState, signatureText } from '@/components/editor/workflows-pane-model';
import { outcomeLabel } from '@/lib/workflow/contract';
import { CHECKPOINT_NODE_TYPE, NODE_SPEC_INDEX, OUTPUT_NODE_TYPE } from '@/lib/workflow/registry';
import { runOutcome } from '@/lib/workflow/run-stats';
import type { GraphNode } from '@/lib/workflow/types';
import { CheckpointPanel, type CheckpointSubmit } from './checkpoint-panel';
import { RunTimeline } from './run-timeline';
import { Muted, OutcomeBadge, Section, StepStatus, summaryOf } from './run-parts';
import type { WorkflowRunView } from './types';

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

/** The run's outcome (the outcome step's record): the value, whether it is signed, and what it rests on. */
function RunResult({ run }: { run: WorkflowRunView }) {
  const node = run.graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  const o = run.outcome;
  if (!node || !o) return null;
  const signed = signatureText(o);
  return (
    <Section title={o.label}>
      <div className="space-y-1 text-sm">
        <p className="font-semibold">{o.valueLabel || outcomeLabel(o.values, o.value)}</p>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{signed ?? (signatureState(o) === 'Advisory' ? 'Advisory' : '')}</p>
        {o.rationale && <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{o.rationale}</p>}
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {o.findings.length} finding{o.findings.length === 1 ? '' : 's'}
          {o.disagreements.length ? ` · ${o.disagreements.length} disagreement${o.disagreements.length === 1 ? '' : 's'}` : ''}
          {o.missing.length ? ` · missing: ${o.missing.join(', ')}` : ''}
        </p>
        {run.document_id && (
          <Link href={`/d/${encodeURIComponent(run.document_id)}`} className="text-xs font-medium text-[var(--go)] hover:underline">
            Open the document (its Workflows tab shows the full outcome)
          </Link>
        )}
      </div>
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
  run: WorkflowRunView;
  node: GraphNode | null;
  canRun: boolean;
  /** Continue a paused run, or record a checkpoint decision; resolves to an error message or null. */
  onContinue: (checkpoint?: CheckpointSubmit) => Promise<string | null>;
  onSelectNode: (nodeId: string) => void;
}) {
  const summary = summaryOf(run);

  if (!node) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Run result</h2>
          <OutcomeBadge outcome={runOutcome(summary)} />
        </div>
        <Muted>Click a node to see what it produced.</Muted>
        {run.status === 'paused' && canRun && (
          <Button size="sm" onClick={() => void onContinue()}>
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
      {node.type === CHECKPOINT_NODE_TYPE && state && (state.status === 'waiting' || run.checkpoints[node.id]) && (
        <CheckpointPanel run={run} nodeId={node.id} canDecide={canRun && run.status !== 'superseded'} onSubmit={(checkpoint) => onContinue(checkpoint)} />
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
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Run log</summary>
        <div className="mt-2">
          <RunTimeline run={summary} onSelectNode={onSelectNode} />
        </div>
      </details>
    </div>
  );
}
