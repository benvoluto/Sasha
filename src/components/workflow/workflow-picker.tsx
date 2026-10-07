'use client';

// Which workflow, and which of its versions, the editor shows and runs: pick a
// workflow or an earlier version, create or rename a workflow, and set the
// default workflow (the one new uploads run unless someone picks another).

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckCircle2, Loader2, PencilLine, Plus } from '@/components/icons';
import type { WorkflowResponse } from './types';

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const when = (iso: string) => new Date(iso).toLocaleDateString();

export function WorkflowPicker({
  info,
  onOpen,
  onChanged,
  onError,
}: {
  info: WorkflowResponse;
  /** Show another workflow (its newest version unless one is given). */
  onOpen: (workflowId: string, version?: number) => void;
  /** Reload after a rename or a new default. */
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'create'>('idle');
  const [name, setName] = useState('');
  const [copyCurrent, setCopyCurrent] = useState(true);
  const [busy, setBusy] = useState(false);
  const isDefault = info.defaultWorkflowId === info.workflow_id;
  const latest = info.versions[0]?.version ?? 0;
  const select = 'h-8 rounded-md border bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setMode('idle');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          Workflow
          <select className={`${select} min-w-[220px] font-medium text-zinc-900 dark:text-zinc-100`} value={info.workflow_id} onChange={(e) => onOpen(e.target.value)}>
            {info.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.id === info.defaultWorkflowId ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          Version
          <select className={select} value={info.version} onChange={(e) => onOpen(info.workflow_id, Number(e.target.value))}>
            {info.versions.length === 0 && <option value={0}>Built-in default</option>}
            {info.versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
                {v.version === latest ? ' · latest' : ''} · {when(v.created_at)}
                {v.note ? ` · ${v.note.slice(0, 40)}` : ''}
              </option>
            ))}
          </select>
        </label>
        {isDefault ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" title="New uploads run this workflow unless someone picks another">
            <CheckCircle2 className="h-3.5 w-3.5" /> Default workflow
          </span>
        ) : (
          info.canEdit && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act(async () => {
              await send('/api/workflows/default', 'PUT', { workflowId: info.workflow_id });
              await onChanged();
            })}>
              Set as default
            </Button>
          )
        )}
        {info.canEdit && mode === 'idle' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => { setName(info.name); setMode('rename'); }}>
              <PencilLine /> Rename
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setName(''); setCopyCurrent(true); setMode('create'); }}>
              <Plus /> New workflow
            </Button>
          </>
        )}
      </div>

      {mode !== 'idle' && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            if (mode === 'rename')
              act(async () => {
                await send(`/api/workflows/${encodeURIComponent(info.workflow_id)}`, 'PATCH', { name: trimmed });
                await onChanged();
              });
            else
              act(async () => {
                const { workflow } = await send('/api/workflows', 'POST', {
                  name: trimmed,
                  ...(copyCurrent ? { from: { workflowId: info.workflow_id, version: info.version } } : {}),
                });
                onOpen(workflow.id);
              });
          }}
        >
          <Input autoFocus className="h-8 w-64" placeholder={mode === 'rename' ? 'Workflow name' : 'Name the new workflow'} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          {mode === 'create' && (
            <select className={select} value={copyCurrent ? 'copy' : 'default'} onChange={(e) => setCopyCurrent(e.target.value === 'copy')} aria-label="Start from">
              <option value="copy">
                Start from a copy of {info.name} v{info.version}
              </option>
              <option value="default">Start from the built-in default</option>
            </select>
          )}
          <Button size="sm" type="submit" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : null} {mode === 'rename' ? 'Rename' : 'Create workflow'}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode('idle')}>
            Cancel
          </Button>
        </form>
      )}

      {info.versions.length > 0 && info.version !== latest && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          You&apos;re viewing version {info.version} of {latest}. Runs from here use version {info.version}; saving an edit makes it version {latest + 1}.
        </p>
      )}
    </div>
  );
}
