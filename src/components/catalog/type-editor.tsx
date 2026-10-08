"use client";

// Editing one document type on the /catalog page (team admins): a form for the
// fields people usually change, and "Advanced: edit JSON" for everything else.
// The server validates; its issues are shown inline under the form. Also the
// "New type" JSON editor (POST).

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { parseDefinition, type DocumentTypeDefinition, type DocumentTypeInput } from "@/catalog/schema";
import { cleanDefinition } from "./catalog-api";

const field = "w-full rounded-md border border-[var(--doc-line)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--doc-accent)]";
const primary = "inline-flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40";
const quiet = "rounded-md px-2 py-1.5 text-sm text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]";
const labelCls = "block text-xs font-medium text-[var(--doc-muted)]";

export function Issues({ error, issues }: { error: string | null; issues: string[] }) {
  if (!error && !issues.length) return null;
  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      {error && <p className="font-medium">{error}</p>}
      {issues.length > 1 && (
        <ul className="ml-4 mt-1 list-disc">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ id, label, value, onChange, rows }: { id: string; label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      {rows ? (
        <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} className={`${field} resize-y`} />
      ) : (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} className={field} />
      )}
    </div>
  );
}

type Props = {
  initial: DocumentTypeDefinition;
  busy: boolean;
  error: string | null;
  issues: string[];
  onSave: (definition: DocumentTypeInput | unknown) => void;
  onCancel: () => void;
};

/** Form + JSON editor for an existing type. */
export function TypeEditor({ initial, busy, error, issues, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<DocumentTypeDefinition>(() => structuredClone(initial));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const set = <K extends keyof DocumentTypeDefinition>(k: K, v: DocumentTypeDefinition[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setSection = (i: number, patch: Partial<DocumentTypeDefinition["sections"][number]>) =>
    setDraft((d) => ({ ...d, sections: d.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const toggleJson = () => {
    if (!jsonMode) {
      setJsonText(JSON.stringify(cleanDefinition(draft), null, 2));
      setJsonError(null);
      setJsonMode(true);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(jsonText);
    } catch {
      setJsonError("That isn't valid JSON; fix it before going back to the form.");
      return;
    }
    const r = parseDefinition(data);
    if (!r.ok) {
      setJsonError(`Fix this before going back to the form: ${r.errors[0]}`);
      return;
    }
    setDraft(r.definition);
    setJsonError(null);
    setJsonMode(false);
  };

  const save = () => {
    if (!jsonMode) return onSave(cleanDefinition(draft));
    try {
      onSave(JSON.parse(jsonText));
      setJsonError(null);
    } catch {
      setJsonError("That isn't valid JSON.");
    }
  };

  const id = (s: string) => `type-edit-${s}`;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <button type="button" onClick={toggleJson} className={quiet}>
          {jsonMode ? "Back to the form" : "Advanced: edit JSON"}
        </button>
      </div>
      {jsonMode ? (
        <div className="space-y-1">
          <label htmlFor={id("json")} className={labelCls}>
            Definition (JSON)
          </label>
          <textarea id={id("json")} spellCheck={false} rows={28} value={jsonText} onChange={(e) => setJsonText(e.target.value)} className={`${field} resize-y font-mono text-xs`} />
        </div>
      ) : (
        <>
          <Field id={id("title")} label="Title" value={draft.title} onChange={(v) => set("title", v)} />
          <Field id={id("summary")} label="Summary" value={draft.summary} onChange={(v) => set("summary", v)} rows={3} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={id("audience")} label="Audience" value={draft.audience} onChange={(v) => set("audience", v)} rows={2} />
            <Field id={id("tone")} label="Tone" value={draft.tone} onChange={(v) => set("tone", v)} rows={2} />
          </div>
          <Field id={id("preamble")} label="How Claude writes it (preamble)" value={draft.preamble} onChange={(v) => set("preamble", v)} rows={5} />
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">Sections</h3>
            {draft.sections.map((s, i) => (
              <fieldset key={s.key} className="space-y-2 rounded-lg border border-[var(--doc-line)] p-3">
                <legend className="px-1 text-xs text-[var(--doc-muted)]">{s.key}</legend>
                <Field id={id(`${s.key}-heading`)} label="Heading" value={s.heading} onChange={(v) => setSection(i, { heading: v })} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={s.required} onChange={(e) => setSection(i, { required: e.target.checked })} /> Required
                </label>
                <Field id={id(`${s.key}-guidance`)} label="Guidance" value={s.guidance} onChange={(v) => setSection(i, { guidance: v })} rows={3} />
                <Field id={id(`${s.key}-length`)} label="Length hint" value={s.lengthHint ?? ""} onChange={(v) => setSection(i, { lengthHint: v })} />
                <Field
                  id={id(`${s.key}-elements`)}
                  label="Elements (one per line)"
                  value={s.elements.join("\n")}
                  onChange={(v) => setSection(i, { elements: v.split("\n") })}
                  rows={Math.max(2, s.elements.length)}
                />
              </fieldset>
            ))}
          </div>
        </>
      )}
      <Issues error={jsonError ?? error} issues={jsonError ? [] : issues} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className={primary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
        </button>
        <button type="button" onClick={onCancel} className={quiet}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "New type": a JSON editor prefilled with a minimal valid template. */
export function NewTypeEditor({ template, busy, error, issues, onCreate, onCancel }: {
  template: DocumentTypeInput;
  busy: boolean;
  error: string | null;
  issues: string[];
  onCreate: (definition: unknown) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(template, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const create = () => {
    try {
      onCreate(JSON.parse(text));
      setJsonError(null);
    } catch {
      setJsonError("That isn't valid JSON.");
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--doc-muted)]">
        Edit the definition below. The key is lowercase words joined by dashes and can&apos;t match a catalog type. Sections need a key, heading, order and guidance.
      </p>
      <label htmlFor="new-type-json" className={labelCls}>
        Definition (JSON)
      </label>
      <textarea id="new-type-json" spellCheck={false} rows={28} value={text} onChange={(e) => setText(e.target.value)} className={`${field} resize-y font-mono text-xs`} />
      <Issues error={jsonError ?? error} issues={jsonError ? [] : issues} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={create} disabled={busy} className={primary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create type
        </button>
        <button type="button" onClick={onCancel} className={quiet}>
          Cancel
        </button>
      </div>
    </div>
  );
}
