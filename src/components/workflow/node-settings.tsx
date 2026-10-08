'use client';

// Settings forms shown on an expanded node card. Every control carries the
// `nodrag nowheel` classes so typing and scrolling don't move the canvas.
// The AI and text nodes have their own forms; the other nodes (the review
// steps, changes, checkpoint and outcome) show their simple settings as fields
// and their complex ones (gate inputs, fields, reviewers, criteria, checks,
// categories, compute checks, outcome values and rules) as JSON, checked live
// against the node's settings schema with the first problem shown.

import { useId, useState } from 'react';
import { Plus, Trash2 } from '@/components/icons';
import { NODE_SPEC_INDEX } from '@/lib/workflow/registry';
import type { GraphNode } from '@/lib/workflow/types';
import { useCanvas } from './canvas-context';

type Config = Record<string, unknown>;
type Props = { node: GraphNode; config: Config; set: (patch: Config) => void; disabled: boolean };

const field = 'nodrag nowheel w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';
const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500';

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={label}>{title}</span>
      {children}
    </div>
  );
}

function ModelFields({ config, set, disabled }: Omit<Props, 'node'>) {
  const { info } = useCanvas();
  // Workflows saved before Claude replaced Gemini read as Claude.
  const provider = config.provider === 'gateway' ? 'gateway' : 'anthropic';
  const missing = provider === 'gateway' ? !info.providers.gateway.configured : !info.providers.anthropic.configured;
  return (
    <div className="grid grid-cols-[1fr_1fr] gap-2">
      <div className={provider === 'gateway' ? '' : 'col-span-2'}>
        <Field title="Provider">
          <select
            className={field}
            disabled={disabled}
            value={provider}
            onChange={(e) => set({ provider: e.target.value, model: e.target.value === 'anthropic' ? info.providers.anthropic.defaultModel : '' })}
          >
            <option value="anthropic">Claude</option>
            <option value="gateway">AI Gateway</option>
          </select>
        </Field>
      </div>
      {/* Claude models take no temperature; only gateway models use it. */}
      {provider === 'gateway' && (
        <Field title={`Temperature ${Number(config.temperature ?? 0).toFixed(1)}`}>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.1}
            disabled={disabled}
            className="nodrag w-full accent-orange-600"
            value={Number(config.temperature ?? 0)}
            onChange={(e) => set({ temperature: Number(e.target.value) })}
          />
        </Field>
      )}
      <div className="col-span-2">
        <Field title="Model">
          <input
            className={field}
            disabled={disabled}
            value={String(config.model ?? '')}
            placeholder={provider === 'gateway' ? 'provider/model' : info.providers.anthropic.defaultModel}
            onChange={(e) => set({ model: e.target.value })}
          />
        </Field>
        {missing && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{provider === 'gateway' ? 'AI_GATEWAY_API_KEY is not set.' : 'ANTHROPIC_API_KEY is not set.'}</p>}
      </div>
    </div>
  );
}

/** A prompt or template, with its inputs as chips that insert {{name}}. */
function TemplateField({ title, value, onChange, variables, disabled, rows = 6 }: { title: string; value: string; onChange: (v: string) => void; variables: string[]; disabled: boolean; rows?: number }) {
  const id = useId();
  return (
    <Field title={title}>
      <textarea id={id} rows={rows} className={`${field} font-mono`} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
      {variables.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {variables.map((v) => (
            <button
              key={v}
              type="button"
              disabled={disabled}
              title={`Insert {{${v}}}`}
              className="nodrag rounded bg-pink-100 px-1.5 py-0.5 font-mono text-[11px] text-pink-800 hover:bg-pink-200 dark:bg-pink-950 dark:text-pink-300"
              onClick={() => {
                const el = document.getElementById(id) as HTMLTextAreaElement | null;
                const at = el?.selectionStart ?? value.length;
                onChange(`${value.slice(0, at)}{{${v}}}${value.slice(at)}`);
              }}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

const toName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40);

/** Editable list of input names (Ask AI, Combine text). */
function InputNames({ names, set, disabled }: { names: string[]; set: (n: string[]) => void; disabled: boolean }) {
  return (
    <Field title="Inputs">
      <div className="space-y-1">
        {names.map((n, i) => (
          <div key={i} className="flex gap-1">
            <input className={`${field} font-mono`} disabled={disabled} value={n} onChange={(e) => set(names.map((x, j) => (j === i ? toName(e.target.value) : x)))} />
            <button type="button" className="nodrag px-1 text-zinc-500 hover:text-red-600 disabled:opacity-40" disabled={disabled || names.length <= 1} onClick={() => set(names.filter((_, j) => j !== i))} title="Remove input">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="nodrag flex items-center gap-1 text-xs text-orange-700 disabled:opacity-40 dark:text-orange-400"
          disabled={disabled || names.length >= 10}
          onClick={() => {
            let i = names.length + 1;
            while (names.includes(`input${i}`)) i++;
            set([...names, `input${i}`]);
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Add input
        </button>
      </div>
    </Field>
  );
}

/** A list of small records edited as rows (extract fields, categories, routes). */
function Rows<T extends Record<string, unknown>>({
  title,
  rows,
  set,
  disabled,
  blank,
  columns,
  min = 1,
  max = 12,
}: {
  title: string;
  rows: T[];
  set: (r: T[]) => void;
  disabled: boolean;
  blank: () => T;
  columns: Array<{ key: keyof T & string; placeholder: string; kind?: 'name' | 'text' | 'check'; wide?: boolean }>;
  min?: number;
  max?: number;
}) {
  return (
    <Field title={title}>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="space-y-1 rounded-md border border-zinc-200 p-1.5 dark:border-zinc-800">
            <div className="flex items-center gap-1">
              {columns
                .filter((c) => !c.wide)
                .map((c) =>
                  c.kind === 'check' ? (
                    <label key={c.key} className="nodrag flex items-center gap-1 whitespace-nowrap text-[11px] text-zinc-600 dark:text-zinc-400">
                      <input type="checkbox" disabled={disabled} checked={!!row[c.key]} onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, [c.key]: e.target.checked } : r)))} />
                      {c.placeholder}
                    </label>
                  ) : (
                    <input
                      key={c.key}
                      className={`${field} ${c.kind === 'name' ? 'font-mono' : ''}`}
                      disabled={disabled}
                      placeholder={c.placeholder}
                      value={String(row[c.key] ?? '')}
                      onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, [c.key]: c.kind === 'name' ? toName(e.target.value) : e.target.value } : r)))}
                    />
                  ),
                )}
              <button type="button" className="nodrag px-1 text-zinc-500 hover:text-red-600 disabled:opacity-40" disabled={disabled || rows.length <= min} onClick={() => set(rows.filter((_, j) => j !== i))} title="Remove">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {columns
              .filter((c) => c.wide)
              .map((c) => (
                <textarea
                  key={c.key}
                  rows={2}
                  className={field}
                  disabled={disabled}
                  placeholder={c.placeholder}
                  value={String(row[c.key] ?? '')}
                  onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, [c.key]: e.target.value } : r)))}
                />
              ))}
          </div>
        ))}
        <button type="button" className="nodrag flex items-center gap-1 text-xs text-orange-700 disabled:opacity-40 dark:text-orange-400" disabled={disabled || rows.length >= max} onClick={() => set([...rows, blank()])}>
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
    </Field>
  );
}

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

/** The first problem zod finds, as "path: message". */
function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const i = error.issues[0];
  if (!i) return 'Not valid';
  const path = i.path.map(String).join('.');
  return path ? `${path}: ${i.message}` : i.message;
}

/**
 * Any node without its own form: strings, numbers and booleans as fields, and
 * everything else as one JSON object, applied only while the whole config
 * passes the node's schema.
 */
function GenericSettings({ node, config, set, disabled }: Props) {
  const spec = NODE_SPEC_INDEX[node.type];
  const scalarKeys = Object.keys(config).filter((k) => isScalar(config[k]));
  const complex = Object.fromEntries(Object.entries(config).filter(([, v]) => !isScalar(v)));
  const complexText = Object.keys(complex).length ? JSON.stringify(complex, null, 2) : '';
  const [text, setText] = useState(complexText);
  const [problem, setProblem] = useState<string | null>(null);
  // The settings changed from outside (a reset, a discard): show them.
  const [shown, setShown] = useState(complexText);
  if (shown !== complexText && !problem) {
    setShown(complexText);
    setText(complexText);
  }
  const check = (next: Record<string, unknown>) => {
    const r = spec?.config.safeParse(next);
    return r && !r.success ? firstIssue(r.error) : null;
  };
  // A field edited into a value the schema refuses (an empty role) is kept here,
  // with the problem shown, until it is valid again: saving it would make the
  // card fall back to the defaults.
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const setScalar = (key: string, value: unknown) => {
    const err = check({ ...config, [key]: value });
    setProblem(err);
    if (err) {
      setDrafts((d) => ({ ...d, [key]: value }));
      return;
    }
    setDrafts((d) => {
      const rest = { ...d };
      delete rest[key];
      return rest;
    });
    set({ [key]: value });
  };
  return (
    <div className="space-y-3">
      {scalarKeys.map((k) => {
        const v = k in drafts ? drafts[k] : config[k];
        if (typeof v === 'boolean')
          return (
            <label key={k} className="nodrag flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" disabled={disabled} checked={v} onChange={(e) => setScalar(k, e.target.checked)} />
              {humanize(k)}
            </label>
          );
        if (typeof v === 'number')
          return (
            <Field key={k} title={humanize(k)}>
              <input type="number" className={field} disabled={disabled} value={v} onChange={(e) => setScalar(k, e.target.value === '' ? 0 : Number(e.target.value))} />
            </Field>
          );
        const long = typeof v === 'string' && (v.length > 60 || /instructions|prompt|brief|guidance|question|template/i.test(k));
        return (
          <Field key={k} title={humanize(k)}>
            {long ? (
              <textarea rows={3} className={field} disabled={disabled} value={String(v ?? '')} onChange={(e) => setScalar(k, e.target.value)} />
            ) : (
              <input className={field} disabled={disabled} value={String(v ?? '')} onChange={(e) => setScalar(k, e.target.value)} />
            )}
          </Field>
        );
      })}
      {complexText && (
        <Field title="Settings (JSON)">
          <textarea
            rows={Math.min(16, Math.max(4, text.split('\n').length))}
            spellCheck={false}
            className={`${field} font-mono text-[11px] ${problem ? 'border-red-500 dark:border-red-500' : ''}`}
            disabled={disabled}
            value={text}
            aria-invalid={!!problem}
            onChange={(e) => {
              const next = e.target.value;
              setText(next);
              let parsed: unknown;
              try {
                parsed = JSON.parse(next);
              } catch (err) {
                setProblem(err instanceof Error ? `JSON: ${err.message}` : 'Not valid JSON');
                return;
              }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setProblem('Settings must be a JSON object');
                return;
              }
              const merged = { ...Object.fromEntries(scalarKeys.map((k) => [k, config[k]])), ...(parsed as Record<string, unknown>) };
              const err = check(merged);
              setProblem(err);
              if (!err) {
                setShown(JSON.stringify(Object.fromEntries(Object.entries(merged).filter(([, v]) => !isScalar(v))), null, 2));
                set(parsed as Record<string, unknown>);
              }
            }}
          />
        </Field>
      )}
      {problem && <p className="text-[11px] text-red-600 dark:text-red-400">{problem}</p>}
      {!scalarKeys.length && !complexText && <p className="text-xs text-zinc-500">No settings.</p>}
    </div>
  );
}

export function NodeSettings({ node, config, set, disabled }: Props) {
  switch (node.type) {
    case 'ai.ask': {
      const inputs = (config.inputs as string[]) ?? [];
      return (
        <div className="space-y-3">
          <TemplateField title="Prompt" value={String(config.prompt ?? '')} onChange={(v) => set({ prompt: v })} variables={inputs} disabled={disabled} />
          <InputNames names={inputs} set={(n) => set({ inputs: n })} disabled={disabled} />
          <ModelFields config={config} set={set} disabled={disabled} />
        </div>
      );
    }
    case 'text.combine': {
      const inputs = (config.inputs as string[]) ?? [];
      return (
        <div className="space-y-3">
          <TemplateField title="Template" value={String(config.template ?? '')} onChange={(v) => set({ template: v })} variables={inputs} disabled={disabled} />
          <InputNames names={inputs} set={(n) => set({ inputs: n })} disabled={disabled} />
        </div>
      );
    }
    case 'ai.extract':
      return (
        <div className="space-y-3">
          <Rows
            title="Fields (each becomes an output)"
            rows={(config.fields as Array<{ name: string; description: string; list: boolean }>) ?? []}
            set={(fields) => set({ fields })}
            disabled={disabled}
            blank={() => ({ name: 'field', description: '', list: false })}
            columns={[
              { key: 'name', placeholder: 'name', kind: 'name' },
              { key: 'list', placeholder: 'list', kind: 'check' },
              { key: 'description', placeholder: 'What to extract', wide: true },
            ]}
          />
          <Field title="Additional context (optional)">
            <textarea rows={2} className={field} disabled={disabled} value={String(config.context ?? '')} onChange={(e) => set({ context: e.target.value })} />
          </Field>
          <ModelFields config={config} set={set} disabled={disabled} />
        </div>
      );
    case 'ai.categorize':
      return (
        <div className="space-y-3">
          <Rows
            title="Categories"
            rows={(config.categories as Array<{ name: string; description: string }>) ?? []}
            set={(categories) => set({ categories })}
            disabled={disabled}
            blank={() => ({ name: 'Category', description: '' })}
            columns={[
              { key: 'name', placeholder: 'Category name' },
              { key: 'description', placeholder: 'What belongs in this category', wide: true },
            ]}
            min={2}
          />
          <ModelFields config={config} set={set} disabled={disabled} />
        </div>
      );
    case 'logic.if':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field title="Condition">
            <select className={field} disabled={disabled} value={String(config.operator)} onChange={(e) => set({ operator: e.target.value })}>
              <option value="contains">contains</option>
              <option value="equals">equals</option>
              <option value="not_empty">is not empty</option>
              <option value="is_empty">is empty</option>
            </select>
          </Field>
          {(config.operator === 'contains' || config.operator === 'equals') && (
            <Field title="Value">
              <input className={field} disabled={disabled} value={String(config.value ?? '')} onChange={(e) => set({ value: e.target.value })} />
            </Field>
          )}
        </div>
      );
    case 'logic.router':
      return (
        <div className="space-y-3">
          <Field title="Match when the key">
            <select className={field} disabled={disabled} value={String(config.mode)} onChange={(e) => set({ mode: e.target.value })}>
              <option value="equals">equals</option>
              <option value="contains">contains</option>
            </select>
          </Field>
          <Rows
            title="Routes (each becomes an output)"
            rows={(config.routes as Array<{ name: string; match: string }>) ?? []}
            set={(routes) => set({ routes })}
            disabled={disabled}
            blank={() => ({ name: 'route', match: '' })}
            columns={[
              { key: 'name', placeholder: 'output', kind: 'name' },
              { key: 'match', placeholder: 'match text' },
            ]}
            max={8}
          />
        </div>
      );
    default:
      return <GenericSettings node={node} config={config} set={set} disabled={disabled} />;
  }
}
