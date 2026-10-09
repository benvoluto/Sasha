"use client";

// The author checkpoint's review (PLAN §6.11, phase8-spec.md §3.3): the
// example(s) on the left with the passages each inferred part came from
// highlighted; the proposed type, workflow and inferred requirement sets on the
// right, each with what was inferred from where. Confidence, differences,
// copied passages (keep or remove) and the personal details that were taken
// out (or that the save still found: a name that is not a person's can be
// kept) sit above the tabs. Save stays off until the draft validates, every
// copied passage is kept or removed, and the author ticks "I reviewed this
// against the examples".

import { useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2, Pencil, ShieldCheck } from "@/components/icons";
import { Issues, TypeEditor } from "@/components/catalog/type-editor";
import { TypeDetail } from "@/components/catalog/type-detail";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { parseDefinition } from "@/catalog/schema";
import { KEEPABLE_PERSONAL_KINDS, LEARN_INFERRED_LABEL, type LearnDraft, type LearnedPart, type PersonalDetailFlag } from "@/lib/learn/contract";
import { applyTypeEdit, currentOverlaps, highlightSegments, keepFlag, keepPersonalFlag, partsFor, removeFlag, saveBlocker, typeEditorStart, type ReviewState } from "./learn-model";

const quiet = "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-xs sm:min-h-8 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-40";
const primary = "inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm sm:min-h-9 font-semibold text-[var(--doc-on-accent)] disabled:opacity-40";
const heading = "text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]";

const CONFIDENCE_LABEL = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" } as const;

function Parts({ items, active, onPick }: { items: Array<{ part: LearnedPart; index: number }>; active: number | null; onPick: (i: number | null) => void }) {
  if (!items.length) return null;
  return (
    <section className="space-y-1.5">
      <h3 className={heading}>What was inferred from where</h3>
      <ul className="space-y-1">
        {items.map(({ part, index }) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => onPick(active === index ? null : index)}
              className={`min-h-11 w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--doc-accent-soft)] sm:min-h-9 ${active === index ? "bg-[var(--doc-accent-soft)]" : ""}`}
            >
              <span className="font-mono text-xs text-[var(--doc-muted)]">{part.path}</span>
              {!part.shared && (
                <Badge variant="secondary" className="ml-2">
                  Not in every example
                </Badge>
              )}
              <span className="block">{part.note}</span>
              {part.from.length > 0 && (
                <span className="block text-xs text-[var(--doc-muted)]">
                  From {part.from.map((f) => `example ${f.example + 1}${f.heading ? ` (“${f.heading}”)` : ""}`).join(", ")}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExamplePane({ draft, active }: { draft: LearnDraft; active: number | null }) {
  const [shown, setShown] = useState(0);
  const example = draft.examples[shown] ?? draft.examples[0];
  // With a part picked, only its passages are highlighted.
  const segments = useMemo(
    () => highlightSegments(example.text, active === null ? draft.parts : draft.parts.map((p, i) => (i === active ? p : { ...p, from: [] })), example.index),
    [example, draft.parts, active],
  );
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {draft.examples.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Examples">
          {draft.examples.map((e, i) => (
            <button key={e.index} type="button" role="tab" aria-selected={i === shown} onClick={() => setShown(i)} className={`min-h-11 rounded-full px-3 py-1 text-xs sm:min-h-8 ${i === shown ? "bg-[var(--doc-accent-soft)] text-[var(--doc-accent)]" : "text-[var(--doc-muted)]"}`}>
              {i + 1}. {e.title}
            </button>
          ))}
        </div>
      )}
      <div className="text-xs text-[var(--doc-muted)]">
        {example.title} · {example.words.toLocaleString()} words{example.truncated ? " · only the first part was read" : ""}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--doc-line)] p-3 text-sm leading-relaxed">
        {segments.map((s, i) =>
          s.parts.length ? (
            <mark key={i} className="rounded bg-[var(--go-soft-strong)] px-0.5 text-inherit" title={s.parts.map((p) => draft.parts[p].note).join("\n")}>
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
    </div>
  );
}

function PersonalList({ flags, title, kept, onKeep }: { flags: PersonalDetailFlag[]; title: string; kept?: string[]; onKeep?: (f: PersonalDetailFlag) => void }) {
  if (!flags.length) return null;
  return (
    <section className="space-y-1">
      <h3 className={heading}>{title}</h3>
      <ul className="space-y-0.5 text-sm">
        {flags.map((f, i) => (
          <li key={`${f.path}-${i}`} className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--doc-muted)]" />
            <span className="line-through decoration-[var(--doc-muted)]">{f.text}</span>
            <span className="text-xs text-[var(--doc-muted)]">
              {f.kind.replace("_", " ")} · {f.removed ? "replaced with a placeholder" : "still in"} {f.path}
            </span>
            {onKeep && KEEPABLE_PERSONAL_KINDS.has(f.kind) && (
              <button type="button" className={quiet} aria-pressed={kept?.includes(f.text)} onClick={() => onKeep(f)} title="Keep it when it names a test, a public body or anything else that is not a person">
                {kept?.includes(f.text) ? "Kept, not personal (undo)" : "Not personal: keep"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LearnReview({
  draft,
  state,
  onChange,
  onSave,
  saving,
  error,
  serverPersonal,
}: {
  draft: LearnDraft;
  state: ReviewState;
  onChange: (s: ReviewState) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  /** Personal details the save route still found (a 422). */
  serverPersonal: PersonalDetailFlag[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<{ error: string | null; issues: string[] }>({ error: null, issues: [] });
  const overlaps = currentOverlaps(state, draft.examples);
  const blocker = saveBlocker(state, draft);
  const { typeOk, initialJson } = typeEditorStart(state.draft.type);
  const v = state.validation;
  const wf = state.draft.workflow;

  const saveEdit = (def: unknown) => {
    const r = parseDefinition(def);
    if (!r.ok) return setEditError({ error: "The type is not valid yet.", issues: r.errors });
    setEditError({ error: null, issues: [] });
    setEditing(false);
    onChange(applyTypeEdit(state, { ...r.definition, key: state.draft.type.key }));
  };

  return (
    <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
      <ExamplePane draft={draft} active={active} />

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        <section className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={draft.confidence === "low" ? "secondary" : "default"}>{CONFIDENCE_LABEL[draft.confidence]}</Badge>
          <span className="text-[var(--doc-muted)]">{draft.confidenceReason}</span>
          {draft.nearestType && (
            <span className="text-xs text-[var(--doc-muted)]">
              Closest catalog type: {draft.nearestType.title} ({draft.nearestType.reason})
            </span>
          )}
        </section>

        {draft.differences.length > 0 && (
          <section className="space-y-1">
            <h3 className={heading}>Where the examples differ (the draft keeps what they share)</h3>
            <ul className="ml-4 list-disc text-sm">
              {draft.differences.map((d, i) => (
                <li key={i}>
                  {d.description} <span className="text-xs text-[var(--doc-muted)]">(example {d.examples.map((e) => e + 1).join(", ")})</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {overlaps.length > 0 && (
          <section className="space-y-1.5 rounded-lg border border-amber-300 p-2 dark:border-amber-800">
            <h3 className={`${heading} flex items-center gap-1.5`}>
              <AlertTriangle className="h-3.5 w-3.5" /> Copied from an example
            </h3>
            <p className="text-xs text-[var(--doc-muted)]">Guidance should describe the pattern, not repeat the example. Remove each passage, or keep it if it is meant to be fixed wording.</p>
            <ul className="space-y-1.5">
              {overlaps.map((f, i) => (
                <li key={`${f.path}-${i}`} className="text-sm">
                  <div className="font-mono text-xs text-[var(--doc-muted)]">
                    {f.path} · {f.words} words from example {f.example + 1}
                  </div>
                  <q className="italic">{f.text}</q>
                  <div className="mt-0.5 flex gap-1">
                    <button type="button" className={quiet} onClick={() => onChange(removeFlag(state, f))}>
                      Remove
                    </button>
                    <button type="button" className={quiet} aria-pressed={state.keep.includes(f.path)} onClick={() => onChange(keepFlag(state, f))}>
                      {state.keep.includes(f.path) ? "Kept (undo)" : "Keep"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <PersonalList flags={draft.personalDetails} title="Personal details taken out" />
        <PersonalList flags={serverPersonal} title="Personal details still in the draft" kept={state.keepPersonal} onKeep={(f) => onChange(keepPersonalFlag(state, f))} />

        <Tabs defaultValue="type" className="gap-2">
          <TabsList>
            <TabsTrigger value="type">Type</TabsTrigger>
            <TabsTrigger value="workflow">Workflow</TabsTrigger>
            <TabsTrigger value="requirements">Requirements ({state.draft.requirementSets.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="type" className="space-y-3">
            <Issues error={v.type.length ? "The type doesn't validate yet." : null} issues={v.type} />
            {state.edited && <p className="flex items-center gap-1.5 text-xs text-[var(--doc-muted)]"><Info className="h-3.5 w-3.5" /> Edited here; it is checked again when you save.</p>}
            {editing ? (
              <TypeEditor
                initial={state.draft.type}
                initialJson={initialJson}
                busy={false}
                error={editError.error}
                issues={editError.issues}
                onSave={saveEdit}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                {/* A type that doesn't parse opens as JSON, so the author can fix it here rather than extract again. */}
                <button type="button" className={quiet} onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" /> {typeOk ? "Edit the type" : "Fix the type (JSON)"}
                </button>
                {typeOk ? <TypeDetail type={state.draft.type} /> : <pre className="overflow-x-auto rounded bg-[var(--doc-accent-soft)] p-2 text-xs">{initialJson}</pre>}
              </>
            )}
            <Parts items={partsFor(draft.parts, "type")} active={active} onPick={setActive} />
          </TabsContent>

          <TabsContent value="workflow" className="space-y-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-9">
              <Checkbox checked={state.withWorkflow} onCheckedChange={(c) => onChange({ ...state, withWorkflow: c === true })} />
              Save this workflow with the type (offered only on documents of this type)
            </label>
            <Issues error={v.workflow.length || v.graph.length ? "The workflow doesn't validate yet." : null} issues={[...v.workflow, ...v.graph]} />
            {wf?.steps ? (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="font-medium">{wf.title}</div>
                  <p className="text-[var(--doc-muted)]">{wf.summary}</p>
                </div>
                <div>
                  <h3 className={heading}>Outcome: {wf.outcome?.label}</h3>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {wf.outcome?.values.map((o) => (
                      <Badge key={o.key} variant="outline">
                        {o.label}
                      </Badge>
                    ))}
                  </div>
                </div>
                {wf.checkpoint && <p>Checkpoint: {wf.checkpoint.role}{wf.checkpoint.required ? " (required)" : ""}</p>}
                <ol className="space-y-1">
                  {wf.steps.map((s) => (
                    <li key={s.id} className="rounded-md border border-[var(--doc-line)] px-2 py-1.5">
                      <span className="font-medium">{s.label ?? s.id}</span> <span className="font-mono text-xs text-[var(--doc-muted)]">{s.node}</span>
                    </li>
                  ))}
                </ol>
                {wf.notAssessed?.length > 0 && <p className="text-xs text-[var(--doc-muted)]">Not assessed: {wf.notAssessed.join("; ")}</p>}
              </div>
            ) : (
              <p className="text-sm text-[var(--doc-muted)]">No workflow could be read from the draft.</p>
            )}
            <Parts items={partsFor(draft.parts, "workflow")} active={active} onPick={setActive} />
          </TabsContent>

          <TabsContent value="requirements" className="space-y-3">
            <Issues error={v.requirementSets.length ? "A requirement set doesn't validate yet." : null} issues={v.requirementSets} />
            {!state.draft.requirementSets.length && <p className="text-sm text-[var(--doc-muted)]">The examples imply no requirement sets.</p>}
            {state.draft.requirementSets.map((s) => (
              <section key={s.key} className="space-y-1 rounded-lg border border-[var(--doc-line)] p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.title}</span>
                  <Badge variant="secondary">{LEARN_INFERRED_LABEL}</Badge>
                </div>
                <ul className="ml-4 list-disc">
                  {s.items?.map((it) => (
                    <li key={it.key}>
                      <span className="font-medium">{it.title}:</span> {it.text}
                      {it.value !== undefined && ` (${it.value} ${it.unit ?? ""})`}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <Parts items={partsFor(draft.parts, "requirements")} active={active} onPick={setActive} />
          </TabsContent>
        </Tabs>

        <div className="sticky bottom-0 space-y-2 border-t border-[var(--doc-line)] bg-[var(--doc-surface)] pt-3">
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <label className="flex min-h-11 cursor-pointer items-start gap-2 py-1.5 text-sm sm:min-h-9">
            <Checkbox className="mt-0.5" checked={state.reviewed} onCheckedChange={(c) => onChange({ ...state, reviewed: c === true })} />
            I reviewed this against the examples: it describes the pattern, copies nothing I don&apos;t mean to keep, and holds no personal details.
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primary} disabled={!!blocker || saving} onClick={onSave}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save type{state.withWorkflow ? " and workflow" : ""}
            </button>
            {blocker && <span className="text-xs text-[var(--doc-muted)]">{blocker}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
