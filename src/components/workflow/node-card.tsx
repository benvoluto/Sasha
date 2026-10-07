'use client';

// A node on the canvas: a header tinted in its type's colour (icon, type, name,
// loop toggle, expand), a white body with the description, run status and, when
// expanded, the node's settings, input ports along the top and output ports along
// the bottom. Selected and running nodes take their type's colour as the border.

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  ArrowsSplit,
  Boxes,
  CheckCircle2,
  Files,
  GitFork,
  HandPalm,
  Hourglass,
  ListChecks,
  Loader2,
  Package,
  Rows3,
  Save,
  Sparkles,
  Tag,
  Trash2,
  XCircle,
} from '@/components/icons';
import { configFor, NODE_SPEC_INDEX, type Category } from '@/lib/workflow/registry';
import type { GraphNode, PortSpec, PortType } from '@/lib/workflow/types';
import { useCanvas } from './canvas-context';
import { NodeSettings } from './node-settings';

export type CardData = { node: GraphNode };
export type CardNode = Node<CardData, 'card'>;

/** A node type's colour, as the classes each part of the card needs. Written out in full so Tailwind finds them. */
type Tone = { header: string; tile: string; kicker: string; border: string; glow: string; hex: string };

const TONES = {
  emerald: { header: 'bg-emerald-50 dark:bg-emerald-950/50', tile: 'bg-emerald-500', kicker: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-500', glow: 'ring-emerald-500/20', hex: '#10b981' },
  sky: { header: 'bg-sky-50 dark:bg-sky-950/50', tile: 'bg-sky-500', kicker: 'text-sky-700 dark:text-sky-400', border: 'border-sky-500', glow: 'ring-sky-500/20', hex: '#0ea5e9' },
  teal: { header: 'bg-teal-50 dark:bg-teal-950/50', tile: 'bg-teal-600', kicker: 'text-teal-700 dark:text-teal-400', border: 'border-teal-600', glow: 'ring-teal-600/20', hex: '#0d9488' },
  violet: { header: 'bg-violet-50 dark:bg-violet-950/50', tile: 'bg-violet-500', kicker: 'text-violet-700 dark:text-violet-400', border: 'border-violet-500', glow: 'ring-violet-500/20', hex: '#8b5cf6' },
  amber: { header: 'bg-amber-50 dark:bg-amber-950/50', tile: 'bg-amber-500', kicker: 'text-amber-700 dark:text-amber-400', border: 'border-amber-500', glow: 'ring-amber-500/20', hex: '#f59e0b' },
  slate: { header: 'bg-slate-100 dark:bg-slate-800/60', tile: 'bg-slate-600', kicker: 'text-slate-600 dark:text-slate-400', border: 'border-slate-600', glow: 'ring-slate-600/20', hex: '#475569' },
  pink: { header: 'bg-pink-50 dark:bg-pink-950/50', tile: 'bg-pink-500', kicker: 'text-pink-700 dark:text-pink-400', border: 'border-pink-500', glow: 'ring-pink-500/20', hex: '#ec4899' },
  orange: { header: 'bg-orange-50 dark:bg-orange-950/50', tile: 'bg-orange-500', kicker: 'text-orange-700 dark:text-orange-400', border: 'border-orange-500', glow: 'ring-orange-500/20', hex: '#f97316' },
} satisfies Record<string, Tone>;

const CATEGORY_TONE: Record<Category, Tone> = { Sources: TONES.emerald, Flow: TONES.violet, AI: TONES.pink, 'Text & logic': TONES.orange };

/**
 * The flow steps each get their own colour, since they mark where a run stops
 * for a person and where it ends; other nodes take their category's.
 */
const TYPE_TONE: Record<string, Tone> = {
  'flow.checkpoint': TONES.amber,
  'output.save': TONES.slate,
};

export const toneFor = (type: string): Tone => TYPE_TONE[type] ?? CATEGORY_TONE[NODE_SPEC_INDEX[type]?.category] ?? TONES.slate;

/** For the node library's category dots. */
export const CATEGORY_STYLE: Record<Category, { chip: string }> = {
  Sources: { chip: TONES.emerald.tile },
  Flow: { chip: TONES.violet.tile },
  AI: { chip: TONES.pink.tile },
  'Text & logic': { chip: TONES.orange.tile },
};

const TYPE_ICON: Record<string, typeof Package> = {
  'source.documents': Files,
  'flow.checkpoint': HandPalm,
  'output.save': Save,
  'ai.ask': Sparkles,
  'ai.extract': ListChecks,
  'ai.categorize': Tag,
  'text.combine': Rows3,
  'logic.if': GitFork,
  'logic.router': ArrowsSplit,
};

const PORT_COLOR: Record<PortType, string> = {
  text: '#71717a',
  any: '#a1a1aa',
  json: '#0ea5e9',
};

const STATUS: Record<string, { label: string; Icon: typeof Package; className: string }> = {
  pending: { label: 'Not started', Icon: Boxes, className: 'text-zinc-400' },
  running: { label: 'Running', Icon: Loader2, className: 'animate-spin text-sky-600 dark:text-sky-400' },
  done: { label: 'Done', Icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'Failed', Icon: XCircle, className: 'text-red-600 dark:text-red-400' },
  skipped: { label: 'Skipped', Icon: Boxes, className: 'text-zinc-400' },
  waiting: { label: 'Needs review', Icon: Hourglass, className: 'text-violet-600 dark:text-violet-400' },
};

function Ports({ ports, kind }: { ports: PortSpec[]; kind: 'target' | 'source' }) {
  return (
    <>
      {ports.map((p, i) => {
        const left = `${((i + 1) / (ports.length + 1)) * 100}%`;
        return (
          <div key={p.name}>
            <Handle
              id={p.name}
              type={kind}
              position={kind === 'target' ? Position.Top : Position.Bottom}
              style={{ left, background: PORT_COLOR[p.type], width: 10, height: 10, border: '2px solid white' }}
            />
            <span
              // A pill with a light shadow: connections run straight through a port's label, and the card layer sits above them.
              className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-white/95 px-1.5 py-px text-[10px] leading-tight text-zinc-600 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:bg-zinc-900/95 dark:text-zinc-300 dark:shadow-[0_1px_3px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]"
              style={{ left, [kind === 'target' ? 'top' : 'bottom']: -22 }}
            >
              {p.label}
              {p.multiple ? ' (many)' : ''}
              {p.optional && kind === 'target' ? ' ?' : ''}
              {p.list && kind === 'source' ? ' []' : ''}
            </span>
          </div>
        );
      })}
    </>
  );
}

export function NodeCard({ id, data, selected }: NodeProps<CardNode>) {
  const { info, run, readOnly, issuesByNode, updateNode, removeNode } = useCanvas();
  const node = data.node;
  const spec = NODE_SPEC_INDEX[node.type];
  if (!spec) return <div className="rounded-lg border border-red-500 bg-white p-3 text-xs">Unknown node type {node.type}</div>;
  const config = configFor(spec, node.config);
  const tone = toneFor(node.type);
  const Icon = TYPE_ICON[node.type] ?? Boxes;
  const state = run?.steps[id];
  const status = state ? STATUS[state.status] : undefined;
  const issues = issuesByNode.get(id) ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const disabled = readOnly || !info.canEdit;

  // Selected and running nodes take their type's colour; a failure is always red.
  const active = selected || state?.status === 'running' || state?.status === 'waiting';
  const frame =
    state?.status === 'failed'
      ? 'border-red-500'
      : active
        ? `${tone.border} ${state?.status === 'running' || state?.status === 'waiting' ? `ring-4 ${tone.glow}` : ''}`
        : 'border-zinc-200 dark:border-zinc-700';

  return (
    <div
      className={`relative w-[300px] rounded-2xl border-2 bg-white transition-[border-color,box-shadow] dark:bg-zinc-900 ${frame} ${
        selected ? 'shadow-[0_2px_4px_rgba(0,0,0,0.06),0_8px_20px_rgba(0,0,0,0.08)]' : 'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.05)]'
      } ${state?.status === 'skipped' ? 'opacity-60' : ''}`}
    >
      <Ports ports={spec.inputs(config)} kind="target" />
      <div className={`rounded-t-[14px] px-3 py-2.5 ${tone.header}`}>
        <div className="flex items-center gap-2.5">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white shadow-sm ${tone.tile}`}>
            <Icon className="h-5 w-5" weight="bold" />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-[10px] font-semibold uppercase tracking-wide ${tone.kicker}`}>{spec.label}</div>
            <input
              className="nodrag w-full truncate bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
              value={node.label ?? spec.label}
              disabled={disabled}
              aria-label="Node name"
              onChange={(e) => updateNode(id, { label: e.target.value.slice(0, 80) })}
            />
          </div>
          {spec.loopable && (
            <label className="nodrag flex items-center gap-1 text-[10px] text-zinc-600 dark:text-zinc-400" title="Run once per item when an input is a list">
              Loop
              <input type="checkbox" disabled={disabled} checked={node.loop} onChange={(e) => updateNode(id, { loop: e.target.checked })} />
            </label>
          )}
          <button
            type="button"
            className="nodrag rounded px-1 text-xs text-zinc-500 hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => updateNode(id, { expanded: !node.expanded })}
            title={node.expanded ? 'Collapse' : 'Show settings'}
          >
            {node.expanded ? '−' : '+'}
          </button>
        </div>
      </div>

      <div className="space-y-1.5 px-3 py-2">
        {!node.expanded && <p className="line-clamp-2 text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">{spec.description}</p>}
        {state && status && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <status.Icon className={`mt-px h-3.5 w-3.5 shrink-0 ${status.className}`} weight="fill" />
            <div className="min-w-0">
              <span className="font-medium">{status.label}</span>
              {state.note ? <span className="text-zinc-500"> · {state.note}</span> : null}
              {state.error ? <div className="line-clamp-2 text-red-600 dark:text-red-400">{state.error}</div> : null}
            </div>
          </div>
        )}
        {errors.length > 0 && (
          <div className="flex items-start gap-1 text-[11px] text-red-600 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{errors[0].message}</span>
          </div>
        )}
      </div>

      {node.expanded && (
        <div className="space-y-3 border-t border-zinc-100 p-3 dark:border-zinc-800">
          <NodeSettings node={node} config={config} set={(patch) => updateNode(id, { config: { ...config, ...patch } })} disabled={disabled} />
          {!disabled && (
            <button type="button" className="nodrag flex items-center gap-1 text-xs text-zinc-500 hover:text-red-600" onClick={() => removeNode(id)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete node
            </button>
          )}
        </div>
      )}
      <Ports ports={spec.outputs(config)} kind="source" />
    </div>
  );
}
