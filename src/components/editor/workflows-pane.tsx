"use client";

// The Workflows tab (PLAN §6.7, phase6-spec.md §8.1): the workflows this
// document can run, grouped "For this type", "For any document" and the
// team's own, each with its outcome values, who signs it off and how its
// latest run ended. Run saves the document first; restructure asks for the
// target type and mode, and a workflow policy turns off shows its reason and
// an acknowledgement that enables Run anyway.
//
// A run's view polls while it runs (2 s) or waits for review (10 s), and a
// run paused at the time budget is continued on its own while the tab is open
// (at most 10 times per run). It shows the steps with loop progress, the
// checkpoint, the outcome card (the fixed value, Advisory or who signed it,
// missing inputs, scores, computed results, requirement sets with "Verify
// before relying"), findings by severity with the passages they rest on,
// disagreements side by side with no averaging, the outcome's tables, and the
// changes the run proposes, which the editor applies as one undo step.
//
// Pure logic lives in workflows-pane-model.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleDashedIcon, CircleMinus, ExternalLink, Loader2, Play, RefreshCw, XCircle } from "@/components/icons";
import { api, errorText } from "@/components/sources/shared";
import { CheckpointPanel, type CheckpointSubmit } from "@/components/workflow/checkpoint-panel";
import {
  OUTCOME_BLOCKED,
  outcomeLabel,
  type AvailableWorkflow,
  type ChangeResultRequest,
  type Disagreement,
  type DocumentWorkflowsResponse,
  type EvidenceLink,
  type Finding,
  type FindingResponseRequest,
  type Outcome,
  type OutcomeTable,
  type ProposedChange,
  type RunBrief,
  type RunResponse,
  type WorkflowRunView,
} from "@/lib/workflow/contract";
import type { AppliedChange } from "./apply-workflow-change";
import { findType, useDocumentTypes } from "./type-picker";
import {
  briefText,
  changeHeadings,
  checkpointText,
  computedLine,
  evidenceLabel,
  findingsBySeverity,
  findingsRespondable,
  formatWhen,
  groupAvailable,
  missingInputs,
  needsForm,
  pendingChanges,
  pollDelay,
  runPlan,
  runStatusText,
  scoreText,
  shouldAutoContinue,
  signatureState,
  signatureText,
  startBlocker,
  startRequest,
  statusTone,
  stepRows,
  stepsDoneText,
  waitingCheckpoints,
  webHref,
  type CheckpointDraft,
  type StartForm,
  type StatusTone,
  type StepItemRow,
  type WorkflowsPrefill,
} from "./workflows-pane-model";

const docWorkflows = (id: string) => `/api/documents/${encodeURIComponent(id)}/workflows`;
const runUrl = (id: string) => `/api/workflow-runs/runs/${encodeURIComponent(id)}`;

/** Automatic continues per run in this session (phase6-spec.md §8.1: at most 10). */
const autoContinued = new Map<string, number>();

const pill = "flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium sm:min-h-9";
const quietPill = `${pill} text-[var(--go)] hover:bg-[var(--go-soft)]`;
const chip = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold";
const field = "w-full rounded-md border border-[var(--doc-line)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--doc-accent)]";

const TONE: Record<StatusTone, string> = {
  busy: "bg-[var(--doc-accent-soft)] text-[var(--doc-accent)]",
  ok: "bg-[var(--go-soft)] text-[var(--go)]",
  wait: "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  bad: "bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  quiet: "bg-[var(--doc-accent-soft)] text-[var(--doc-muted)]",
};

export type WorkflowsPaneProps = {
  documentId: string | null;
  typeKey: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** Opened from the classifier chip: this workflow (restructure) with its target type chosen. */
  prefill?: WorkflowsPrefill | null;
  onPrefillDone?: () => void;
  /** Applies a proposed change in the editor (apply-workflow-change.ts). Without it, Apply is disabled. */
  onApplyChange?: (change: ProposedChange) => Promise<AppliedChange>;
  /** A change was applied and recorded: back to the document. */
  onChangeApplied?: () => void;
  /** A finding's location: scroll the editor to the section. */
  onJumpToSection?: (sectionId: string) => void;
  /** "Open in Sources" (with the source to focus) and the missing inputs' "Go to Sources". */
  onOpenSources?: (sourceId: string | null) => void;
  /**
   * The pane mounts only while its tab is open: the parent keeps the run being
   * looked at and the half-filled checkpoint drafts (by run and checkpoint), so
   * checking a source and coming back finds both as they were.
   */
  view?: WorkflowsView;
  onViewChange?: (view: WorkflowsView) => void;
  checkpointDrafts?: Record<string, CheckpointDraft>;
  onCheckpointDraft?: (key: string, draft: CheckpointDraft | null) => void;
};

export type WorkflowsView = { kind: "list" } | { kind: "run"; runId: string; readOnly: boolean };
type View = WorkflowsView;

/** The key a checkpoint draft is kept under. */
export const draftKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

export function WorkflowsPane(props: WorkflowsPaneProps) {
  const { documentId, ensureSaved, prefill = null, onPrefillDone } = props;
  const [data, setData] = useState<DocumentWorkflowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setOwnView] = useState<View>(props.view ?? { kind: "list" });
  const setView = (v: View) => {
    setOwnView(v);
    props.onViewChange?.(v);
  };
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [form, setForm] = useState<StartForm>({ targetType: "", mode: "merge", acknowledged: false });
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setData(null);
      return;
    }
    try {
      setData(await api<DocumentWorkflowsResponse>(docWorkflows(id)));
      setError(null);
    } catch (e) {
      setError(errorText(e, "Couldn't load the workflows."));
    }
  }, []);

  // Save what is queued (a type picked a moment ago) before asking what can run.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = documentId ? await ensureSaved().catch(() => documentId) : null;
      if (!cancelled) await load(id ?? documentId);
    })();
    return () => {
      cancelled = true;
    };
    // ensureSaved changes identity with the editor; loading once per document is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, load]);

  // The chip's "Restructure…": open that workflow's form with the type chosen.
  const prefillKey = prefill ? `${prefill.workflowKey}:${prefill.targetType ?? ""}` : null;
  useEffect(() => {
    if (!prefill || !data) return;
    const w = data.available.find((a) => a.key === prefill.workflowKey);
    if (!w) return;
    setView({ kind: "list" });
    setOpenForm(w.id);
    setForm({ targetType: prefill.targetType ?? "", mode: "merge", acknowledged: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey, data]);

  const start = async (w: AvailableWorkflow) => {
    setStarting(w.id);
    setStartError(null);
    try {
      const id = await ensureSaved();
      if (!id) throw new Error("Save the document before running a workflow.");
      const { run } = await api<RunResponse>(docWorkflows(id), { method: "POST", json: startRequest(w, form) });
      setOpenForm(null);
      if (prefill) onPrefillDone?.();
      setView({ kind: "run", runId: run.id, readOnly: false });
    } catch (e) {
      setStartError({ id: w.id, text: errorText(e, "Couldn't start the workflow.") });
    } finally {
      setStarting(null);
    }
  };

  if (view.kind === "run") {
    return (
      <RunView
        key={view.runId}
        runId={view.runId}
        readOnly={view.readOnly}
        {...props}
        onBack={() => {
          setView({ kind: "list" });
          void load(documentId);
        }}
      />
    );
  }

  const groups = data ? groupAvailable(data.available) : [];
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 sm:px-6">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {!documentId ? (
        <p className="text-sm text-[var(--doc-muted)]">Workflows appear once the document is saved.</p>
      ) : !data ? (
        !error && (
          <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading workflows…
          </p>
        )
      ) : (
        <>
          {!data.typeKey && <p className="text-sm text-[var(--doc-muted)]">Choose a document type to see the workflows made for it.</p>}
          {groups.map((g) => (
            <section key={g.kind} aria-label={g.title} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">{g.title}</h3>
              <ul className="space-y-2">
                {g.items.map((w) => (
                  <li key={w.id}>
                    <WorkflowRow
                      workflow={w}
                      formOpen={openForm === w.id}
                      form={form}
                      setForm={setForm}
                      starting={starting === w.id}
                      error={startError?.id === w.id ? startError.text : null}
                      onToggleForm={() => {
                        setStartError(null);
                        setOpenForm(openForm === w.id ? null : w.id);
                        if (openForm !== w.id) setForm({ targetType: prefill?.workflowKey === w.key ? (prefill.targetType ?? "") : "", mode: "merge", acknowledged: false });
                      }}
                      onRun={() => void start(w)}
                      onOpenRun={(id) => setView({ kind: "run", runId: id, readOnly: false })}
                      currentType={data.typeKey}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <RunHistory runs={data.runs} onOpen={(r) => setView({ kind: "run", runId: r.id, readOnly: true })} />
        </>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: WorkflowRunView["status"] }) {
  return (
    <span className={`${chip} ${TONE[statusTone(status)]} gap-1`}>
      {status === "running" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {runStatusText(status)}
    </span>
  );
}

function WorkflowRow({
  workflow: w,
  formOpen,
  form,
  setForm,
  starting,
  error,
  onToggleForm,
  onRun,
  onOpenRun,
  currentType,
}: {
  workflow: AvailableWorkflow;
  formOpen: boolean;
  form: StartForm;
  setForm: (f: StartForm) => void;
  starting: boolean;
  error: string | null;
  onToggleForm: () => void;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
  currentType: string | null;
}) {
  const rowRef = useRef<HTMLElement>(null);
  const withForm = needsForm(w);
  const blocker = startBlocker(w, form);
  const formId = `wf-form-${w.id.replace(/\W/g, "-")}`;
  // Opened from the chip: bring the form into view.
  useEffect(() => {
    if (formOpen) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [formOpen]);
  const latest = w.latestRun;
  return (
    <article ref={rowRef} aria-label={w.title} className="rounded-xl border border-[var(--doc-line)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words text-sm font-semibold leading-snug">{w.title}</p>
          {w.summary && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{w.summary}</p>}
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-[var(--doc-muted)]">{w.outcome.label}:</span>
            {w.outcome.values.map((v) => (
              <span key={v.key} title={v.description} className={`${chip} bg-[var(--doc-accent-soft)] font-medium text-[var(--doc-muted)]`}>
                {v.label}
              </span>
            ))}
          </div>
          {checkpointText(w) && <p className="text-xs text-[var(--doc-muted)]">{checkpointText(w)}</p>}
          {!w.enabled && w.disabledReason && <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">{w.disabledReason}</p>}
          {latest && (
            <button type="button" onClick={() => onOpenRun(latest.id)} className="-ml-1 flex min-h-11 flex-wrap items-center gap-1.5 rounded-md px-1 text-left text-xs hover:bg-[var(--go-soft)] sm:min-h-8">
              <span className="text-[var(--doc-muted)]">Latest run:</span>
              <StatusChip status={latest.status} />
              {latest.outcome && <span className="font-medium">{briefText(latest)}</span>}
              <span className="text-[var(--doc-muted)]">{formatWhen(latest.created_at)}</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={withForm ? onToggleForm : onRun}
          disabled={starting || (!withForm && !!blocker)}
          aria-expanded={withForm ? formOpen : undefined}
          aria-controls={withForm ? formId : undefined}
          title={!withForm && blocker ? blocker : undefined}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-[var(--doc-accent)] px-3 text-xs font-semibold text-[var(--doc-on-accent)] disabled:opacity-40 sm:min-h-9"
        >
          {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />} Run{withForm ? "…" : ""}
        </button>
      </div>

      {withForm && formOpen && (
        <form
          id={formId}
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocker) onRun();
          }}
          className="mt-3 space-y-3 rounded-lg bg-[var(--doc-accent-soft)]/60 p-3"
        >
          {w.params.includes("targetType") && <TargetTypeField value={form.targetType} currentType={currentType} onChange={(targetType) => setForm({ ...form, targetType })} />}
          {w.params.includes("mode") && (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-[var(--doc-muted)]">How</legend>
              {(
                [
                  ["merge", "Move text as it is", "Parts move word for word into the type's sections."],
                  ["rewrite", "Move, then smooth the wording", "After moving, each section is reworded to read well. No facts are added."],
                ] as const
              ).map(([mode, label, help]) => (
                <label key={mode} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--go-soft)] sm:min-h-9">
                  <input type="radio" name={`${formId}-mode`} value={mode} checked={form.mode === mode} onChange={() => setForm({ ...form, mode })} className="mt-1 accent-[var(--go)]" />
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="block text-xs text-[var(--doc-muted)]">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {!w.enabled && w.acknowledge && (
            <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" checked={form.acknowledged} onChange={(e) => setForm({ ...form, acknowledged: e.target.checked })} className="mt-1 h-4 w-4 accent-[var(--go)]" />
              <span>{w.acknowledge.text}</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={!!blocker || starting} className="flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-40 sm:min-h-9">
              {starting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Run {w.title}
            </button>
            <button type="button" onClick={onToggleForm} className="min-h-11 rounded-md px-2 text-sm text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] sm:min-h-9">
              Cancel
            </button>
            {blocker && <span className="text-xs text-[var(--doc-muted)]">{blocker}</span>}
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </article>
  );
}

/** The restructure target: the team's enabled types (the type picker's list). */
function TargetTypeField({ value, currentType, onChange }: { value: string; currentType: string | null; onChange: (key: string) => void }) {
  const { types, loading } = useDocumentTypes();
  const enabled = types.filter((t) => t.enabled);
  return (
    <div className="space-y-1">
      <label htmlFor="wf-target-type" className="block text-xs font-medium text-[var(--doc-muted)]">
        Restructure to
      </label>
      <select id="wf-target-type" value={value} onChange={(e) => onChange(e.target.value)} className={`${field} min-h-11 sm:min-h-9`}>
        <option value="">{loading && !enabled.length ? "Loading types…" : "Choose a type"}</option>
        {enabled.map((t) => (
          <option key={t.key} value={t.key}>
            {t.title}
            {t.key === currentType ? " (current type)" : ""}
          </option>
        ))}
        {value && !enabled.some((t) => t.key === value) && <option value={value}>{value}</option>}
      </select>
    </div>
  );
}

function RunHistory({ runs, onOpen }: { runs: RunBrief[]; onOpen: (r: RunBrief) => void }) {
  if (!runs.length) return null;
  return (
    <section aria-label="Run history" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">Run history</h3>
      <ul className="divide-y divide-[var(--doc-line)] rounded-xl border border-[var(--doc-line)]">
        {runs.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r)} className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-[var(--go-soft)]">
              <span className="min-w-0 flex-1 truncate font-medium">{r.workflow_name}</span>
              <span className="text-xs">{briefText(r)}</span>
              <span className="basis-full text-xs text-[var(--doc-muted)] sm:basis-auto">
                {r.requested_by} · {formatWhen(r.created_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- A run ------------------------------------------------------------------------------

function RunView({
  runId,
  readOnly,
  onBack,
  onApplyChange,
  onChangeApplied,
  onJumpToSection,
  onOpenSources,
  checkpointDrafts,
  onCheckpointDraft,
}: WorkflowsPaneProps & { runId: string; readOnly: boolean; onBack: () => void }) {
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Failed polls in a row: each one re-arms the poll (backing off), so a dropped request doesn't stop it.
  const [failures, setFailures] = useState(0);
  const [continuing, setContinuing] = useState(false);
  const { types } = useDocumentTypes();

  const fetchRun = useCallback(async () => {
    try {
      const { run: fresh } = await api<RunResponse>(runUrl(runId));
      setRun(fresh);
      setError(null);
      setFailures(0);
      return fresh;
    } catch (e) {
      setError(errorText(e, "Couldn't load the run."));
      setFailures((n) => n + 1);
      return null;
    }
  }, [runId]);

  const continueRun = useCallback(
    async (body: { checkpoint?: CheckpointSubmit } = {}): Promise<string | null> => {
      try {
        const { run: next } = await api<RunResponse>(`${runUrl(runId)}/continue`, { method: "POST", json: body });
        setRun(next);
        return null;
      } catch (e) {
        // Often someone else (another viewer, the canvas) continued it first: pick up where it is now.
        void fetchRun();
        return errorText(e, "Couldn't continue the run.");
      }
    },
    [runId, fetchRun],
  );

  useEffect(() => {
    void fetchRun();
  }, [fetchRun]);

  // Poll while it runs or waits; continue a budget pause on its own. Re-armed
  // on every fresh copy of the run (its updated_at can stay the same while
  // steps run) and after every failed poll. A failed continue refetches the run
  // (continueRun), which re-arms this.
  useEffect(() => {
    if (!run) return;
    if (!readOnly && shouldAutoContinue(run, autoContinued.get(run.id) ?? 0)) {
      autoContinued.set(run.id, (autoContinued.get(run.id) ?? 0) + 1);
      void continueRun().then((err) => err && setError(err));
      return;
    }
    const delay = pollDelay(run.status, failures);
    if (delay === null) return;
    const t = window.setTimeout(() => void fetchRun(), delay);
    return () => window.clearTimeout(t);
  }, [run, failures, readOnly, fetchRun, continueRun]);

  const post = async <T,>(path: string, json: T, fallback: string): Promise<string | null> => {
    try {
      const { run: next } = await api<RunResponse>(`${runUrl(runId)}/${path}`, { method: "POST", json });
      setRun(next);
      return null;
    } catch (e) {
      return errorText(e, fallback);
    }
  };

  if (!run) {
    return (
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6 sm:px-6">
        <BackButton onBack={onBack} />
        {error ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
            <button type="button" onClick={() => void fetchRun()} className={`${pill} hover:bg-[var(--doc-accent-soft)]`}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Retry
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the run…
          </p>
        )}
      </div>
    );
  }

  const interactive = !readOnly && run.status !== "superseded";
  const steps = stepRows(run);
  const waiting = waitingCheckpoints(run);
  const decided = Object.keys(run.checkpoints ?? {}).filter((id) => !waiting.some((w) => w.id === id));
  const plan = runPlan(run);
  const targetSections = plan ? (findType(types, plan.targetType)?.sections ?? []).map((s) => ({ key: s.key, heading: s.heading })) : [];
  const headingFor = (key: string) => targetSections.find((s) => s.key === key)?.heading ?? key;
  const changes = pendingChanges(run);
  const auto = (autoContinued.get(run.id) ?? 0) > 0;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6 sm:px-6">
      <div className="space-y-1">
        <BackButton onBack={onBack} />
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 break-words text-base font-semibold">{run.workflow_name}</h3>
          <StatusChip status={run.status} />
          {readOnly && <span className={`${chip} ${TONE.quiet}`}>Read only</span>}
        </div>
        <p className="text-xs text-[var(--doc-muted)]">
          Started by {run.requested_by}, {formatWhen(run.created_at)}
          {run.params.targetType ? ` · to ${findType(types, run.params.targetType)?.title ?? run.params.targetType} (${run.params.mode ?? "merge"})` : ""}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {run.status === "paused" && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          <span className="min-w-0 flex-1">
            {run.pause_reason === "budget" && interactive && shouldAutoContinue(run, autoContinued.get(run.id) ?? 0)
              ? "Taking a breath between steps; continuing…"
              : run.pause_reason === "budget"
                ? "The run paused to stay within its time limit."
                : "The run is paused."}
          </span>
          {interactive && (
            <button
              type="button"
              disabled={continuing}
              onClick={async () => {
                setContinuing(true);
                const err = await continueRun();
                setContinuing(false);
                if (err) setError(err);
              }}
              className={`${pill} hover:bg-amber-100 dark:hover:bg-amber-900/60`}
            >
              {continuing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Continue
            </button>
          )}
        </div>
      )}

      <details open={run.status === "running" || (run.status === "paused" && auto)} className="rounded-xl border border-[var(--doc-line)] px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium sm:min-h-8">
          Steps <span className="font-normal text-[var(--doc-muted)]">({stepsDoneText(steps)})</span>
          {run.status === "running" && (
            <button type="button" onClick={() => void fetchRun()} aria-label="Refresh" title="Refresh" className="ml-auto grid h-9 w-9 place-items-center rounded-full text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </button>
          )}
        </summary>
        <ol className="mt-1 space-y-1 pb-1">
          {steps.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className={`${chip} ${TONE[stepTone(s.status)]}`}>{stepWord(s.status)}</span>
              <span className={s.status === "skipped" || s.status === "pending" ? "text-[var(--doc-muted)]" : ""}>{s.label}</span>
              {s.progress && <span className="text-xs text-[var(--doc-muted)]">{s.progress}</span>}
              {s.note && <span className="text-xs text-[var(--doc-muted)]">{s.note}</span>}
              {s.error && <span className="basis-full text-xs text-red-700 dark:text-red-300">{s.error}</span>}
              {s.items.length > 0 && (
                <ul aria-label={`${s.label}: items`} className="mb-1 ml-1 basis-full space-y-0.5 border-l border-[var(--doc-line)] pl-3">
                  {s.items.map((it) => (
                    <li key={it.key} className="flex items-center gap-1.5 text-xs">
                      <ItemStateIcon state={it.state} />
                      <span className={it.state === "pending" || it.state === "skipped" ? "text-[var(--doc-muted)]" : ""}>{it.label}</span>
                      <span className="text-[var(--doc-muted)]">· {it.stateText}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </details>

      {waiting.map((c) => (
        <CheckpointPanel
          key={c.id}
          run={run}
          nodeId={c.id}
          canDecide={interactive}
          sections={targetSections}
          onSubmit={(checkpoint) => continueRun({ checkpoint })}
          savedDraft={checkpointDrafts?.[draftKey(run.id, c.id)] ?? null}
          onDraftChange={onCheckpointDraft ? (d) => onCheckpointDraft(draftKey(run.id, c.id), d) : undefined}
        />
      ))}
      {decided.map((id) => (
        <CheckpointPanel key={id} run={run} nodeId={id} canDecide={false} sections={targetSections} onSubmit={async () => null} />
      ))}

      {changes.map((c) => (
        <ChangeCard
          key={c.id}
          change={c}
          headingFor={headingFor}
          canApply={interactive && !!onApplyChange}
          onApply={async () => {
            if (!onApplyChange) return "Open the document to apply this change.";
            const out = await onApplyChange(c);
            if (out.result === null) return out.detail;
            const err = await post<ChangeResultRequest>("changes", { changeId: c.id, result: out.result, detail: out.detail.slice(0, 1000) }, "The change was made, but couldn't be recorded.");
            if (err) return err;
            if (out.result === "applied") onChangeApplied?.();
            return null;
          }}
          onDiscard={() => post<ChangeResultRequest>("changes", { changeId: c.id, result: "discarded" }, "Couldn't discard the change.")}
        />
      ))}
      {Object.entries(run.changes ?? {}).map(([id, r]) => (
        <p key={id} className="text-xs text-[var(--doc-muted)]">
          {run.proposed.find((p) => p.id === id)?.title ?? "Change"}: {r.result === "applied" ? "applied" : r.result === "discarded" ? "discarded" : "skipped"} by {r.by}, {formatWhen(r.at)}
          {r.detail ? `. ${r.detail}` : ""}
        </p>
      ))}

      {run.outcome && <OutcomeCard run={run} outcome={run.outcome} onOpenSources={onOpenSources} />}

      {run.outcome && run.outcome.disagreements.length > 0 && <Disagreements items={run.outcome.disagreements} onOpenSources={onOpenSources} onJumpToSection={onJumpToSection} />}

      {run.outcome && run.outcome.findings.length > 0 && (
        <Findings
          findings={run.outcome.findings}
          responses={run.responses ?? {}}
          respondable={interactive && findingsRespondable(run)}
          onRespond={(findingId, state) => post<FindingResponseRequest>("findings", { findingId, state }, "Couldn't save that.")}
          onJumpToSection={onJumpToSection}
          onOpenSources={onOpenSources}
        />
      )}

      {run.outcome?.tables.map((t) => <OutcomeTableView key={t.key} table={t} onOpenSources={onOpenSources} />)}
    </div>
  );
}

/** A loop item's state as an icon; the state is also written out beside it, so the icon is decorative. */
function ItemStateIcon({ state }: { state: StepItemRow["state"] }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (state === "done") return <Check className={`${cls} text-emerald-700 dark:text-emerald-400`} aria-hidden />;
  if (state === "running") return <Loader2 className={`${cls} animate-spin text-[var(--doc-accent)]`} aria-hidden />;
  if (state === "failed") return <XCircle className={`${cls} text-red-700 dark:text-red-300`} aria-hidden />;
  if (state === "skipped") return <CircleMinus className={`${cls} text-[var(--doc-muted)]`} aria-hidden />;
  return <CircleDashedIcon className={`${cls} text-[var(--doc-muted)]`} aria-hidden />;
}

function stepTone(status: string): StatusTone {
  return ({ done: "ok", failed: "bad", running: "busy", waiting: "wait" } as Record<string, StatusTone>)[status] ?? "quiet";
}

function stepWord(status: string): string {
  return { done: "Done", failed: "Failed", running: "Running", waiting: "Waiting", skipped: "Skipped", pending: "Not started" }[status] ?? status;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className={`${quietPill} -ml-3`}>
      <ArrowLeft className="h-4 w-4" aria-hidden /> All workflows
    </button>
  );
}

// --- Outcome -------------------------------------------------------------------------------

function OutcomeCard({ run, outcome: o, onOpenSources }: { run: WorkflowRunView; outcome: Outcome; onOpenSources?: (sourceId: string | null) => void }) {
  const state = signatureState(o);
  const signed = signatureText(o);
  const missing = o.value === OUTCOME_BLOCKED ? missingInputs(run, o) : [];
  const valueTone = o.value === null ? TONE.bad : o.value === OUTCOME_BLOCKED ? TONE.wait : TONE.ok;
  return (
    <section aria-label={o.label} className="space-y-3 rounded-xl border border-[var(--doc-line)] px-3 py-3">
      <div className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">{o.label}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${valueTone}`}>{o.valueLabel || outcomeLabel(o.values, o.value)}</span>
          {state === "Advisory" && (
            <span className={`${chip} ${TONE.quiet}`} title="Advisory until the checkpoint signs it off">
              Advisory
            </span>
          )}
          {state === "Rejected" && <span className={`${chip} ${TONE.bad}`}>Rejected</span>}
          {state === "Signed" && <span className={`${chip} ${TONE.ok}`}>Signed</span>}
        </div>
        {signed && <p className="text-xs text-[var(--doc-muted)]">{signed}</p>}
        {o.originalValue && o.originalValue !== o.value && <p className="text-xs text-[var(--doc-muted)]">Changed at the checkpoint from “{outcomeLabel(o.values, o.originalValue)}”.</p>}
        {Object.keys(o.record ?? {}).length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            {Object.entries(o.record).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[var(--doc-muted)]">{k.replace(/_/g, " ")}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {o.rationale && <p className="whitespace-pre-wrap text-sm leading-relaxed">{o.rationale}</p>}

      {missing.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Missing before this can run</p>
          <ul className="space-y-1.5">
            {missing.map((m) => (
              <li key={m.label} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/50 dark:text-amber-100">
                <p className="font-medium">{m.label}</p>
                {m.help && <p className="text-xs leading-relaxed">{m.help}</p>}
              </li>
            ))}
          </ul>
          {onOpenSources && (
            <button type="button" onClick={() => onOpenSources(null)} className={`${quietPill} -ml-3`}>
              Go to Sources
            </button>
          )}
        </div>
      )}

      {o.incomplete.length > 0 && <p className="text-sm text-red-700 dark:text-red-300">No value was reached because these steps didn&apos;t finish: {o.incomplete.join(", ")}.</p>}

      {o.scores.length > 0 && (
        <Block title="Scores">
          <ul className="space-y-1 text-sm">
            {o.scores.map((s) => (
              <li key={`${s.nodeId}:${s.item}`}>
                <span className="font-medium">{s.label}</span> <span className="text-[var(--doc-muted)]">{scoreText(s)}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {o.computed.length > 0 && (
        <Block title="Checked in code">
          <ul className="space-y-1.5 text-sm">
            {o.computed.map((c) => {
              const l = computedLine(c);
              return (
                <li key={l.key}>
                  <span className={`${chip} mr-1.5 ${l.status === "ok" ? TONE.ok : l.status === "failed" ? TONE.bad : TONE.quiet}`}>{l.status === "ok" ? "OK" : l.status === "failed" ? "Check" : "Not computed"}</span>
                  <span className="font-medium">{l.label}</span> <span>{l.text}</span>
                  {l.estimate && <span className={`${chip} ml-1.5 ${TONE.wait}`}>estimate</span>}
                  {l.detail && <span className="block text-xs text-[var(--doc-muted)]">{l.detail}</span>}
                </li>
              );
            })}
          </ul>
        </Block>
      )}

      {o.agreed.length > 0 && (
        <details className="text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center sm:min-h-8">Reviewers agreed on {o.agreed.length} item{o.agreed.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {o.agreed.map((a) => (
              <li key={a.item}>
                <span className="font-medium">{a.label}</span>
                {a.verdict ? `: ${a.verdict.replace(/_/g, " ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {o.notAssessed.length > 0 && (
        <Block title="Not assessed">
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {o.notAssessed.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Block>
      )}

      {o.notes.length > 0 && (
        <Block title="Notes">
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {o.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Block>
      )}

      {o.requirementSets.length > 0 && (
        <Block title="Rules relied on">
          <ul className="space-y-2 text-sm">
            {o.requirementSets.map((r) => (
              <li key={r.key} className="rounded-lg bg-[var(--doc-accent-soft)]/60 px-3 py-2">
                <p className="font-medium">{r.title}</p>
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">Verify before relying</p>
                {r.verifyNote && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{r.verifyNote}</p>}
                <p className="text-xs text-[var(--doc-muted)]">
                  {[r.effective && `Effective ${r.effective}`, r.checked && `checked ${r.checked}`].filter(Boolean).join(" · ")}
                  {r.url && (
                    <>
                      {" · "}
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[var(--go)] underline-offset-2 hover:underline">
                        Source <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">{title}</p>
      {children}
    </div>
  );
}

// --- Findings and evidence --------------------------------------------------------------------

function Findings({
  findings,
  responses,
  respondable,
  onRespond,
  onJumpToSection,
  onOpenSources,
}: {
  findings: Finding[];
  responses: WorkflowRunView["responses"];
  respondable: boolean;
  onRespond: (findingId: string, state: FindingResponseRequest["state"]) => Promise<string | null>;
  onJumpToSection?: (sectionId: string) => void;
  onOpenSources?: (sourceId: string | null) => void;
}) {
  return (
    <section aria-label="Findings" className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">Findings ({findings.length})</h3>
      {findingsBySeverity(findings).map((g) => (
        <div key={g.severity} className="space-y-1.5">
          <p className="text-xs font-medium">
            {g.label} <span className="font-normal text-[var(--doc-muted)]">({g.items.length})</span>
          </p>
          <ul className="space-y-1.5">
            {g.items.map((f) => (
              <li key={f.id}>
                <FindingCard finding={f} response={responses[f.id]?.state ?? "open"} respondable={respondable} onRespond={onRespond} onJumpToSection={onJumpToSection} onOpenSources={onOpenSources} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

const SEVERITY_EDGE: Record<Finding["severity"], string> = {
  blocking: "border-l-red-600",
  major: "border-l-amber-500",
  minor: "border-l-[var(--doc-accent-line,var(--doc-line))]",
  info: "border-l-[var(--doc-line)]",
};

function FindingCard({
  finding: f,
  response,
  respondable,
  onRespond,
  onJumpToSection,
  onOpenSources,
}: {
  finding: Finding;
  response: FindingResponseRequest["state"];
  respondable: boolean;
  onRespond: (findingId: string, state: FindingResponseRequest["state"]) => Promise<string | null>;
  onJumpToSection?: (sectionId: string) => void;
  onOpenSources?: (sourceId: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (state: FindingResponseRequest["state"]) => {
    setBusy(true);
    setError(null);
    const err = await onRespond(f.id, state);
    setBusy(false);
    if (err) setError(err);
  };
  const where = f.location?.heading || f.location?.quote;
  return (
    <article className={`space-y-1.5 rounded-xl border border-l-4 border-[var(--doc-line)] px-3 py-2.5 ${SEVERITY_EDGE[f.severity]} ${response === "dismissed" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">{f.title}</p>
        {!f.verified && <span className={`${chip} ${TONE.wait}`}>Unverified</span>}
        {f.reviewer && <span className={`${chip} ${TONE.quiet}`}>{f.reviewer.replace(/_/g, " ")}</span>}
        {response !== "open" && <span className={`${chip} ${response === "accepted" ? TONE.ok : TONE.quiet}`}>{response === "accepted" ? "Accepted" : "Dismissed"}</span>}
      </div>
      {f.detail && <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--doc-muted)]">{f.detail}</p>}
      {f.location?.sectionId && where && onJumpToSection ? (
        <button type="button" onClick={() => onJumpToSection(f.location!.sectionId!)} className="-ml-1 flex min-h-11 items-center rounded-md px-1 text-left text-xs text-[var(--go)] hover:bg-[var(--go-soft)] sm:min-h-7">
          In “{f.location.heading || "the section"}”{f.location.quote ? `: “${f.location.quote.slice(0, 120)}${f.location.quote.length > 120 ? "…" : ""}”` : ""}
        </button>
      ) : where ? (
        <p className="text-xs text-[var(--doc-muted)]">In “{where}”</p>
      ) : null}
      {f.fix && <p className="text-xs">Suggested fix: {f.fix}</p>}
      <Evidence links={f.evidence} onOpenSources={onOpenSources} onJumpToSection={onJumpToSection} />
      {respondable && (
        <div className="flex flex-wrap items-center gap-1">
          {response !== "accepted" && (
            <button type="button" disabled={busy} onClick={() => void respond("accepted")} className={`${quietPill} text-xs`}>
              Accept
            </button>
          )}
          {response !== "dismissed" && (
            <button type="button" disabled={busy} onClick={() => void respond("dismissed")} className={`${pill} text-xs text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]`}>
              Dismiss
            </button>
          )}
          {response !== "open" && (
            <button type="button" disabled={busy} onClick={() => void respond("open")} className={`${pill} text-xs text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]`}>
              Undo
            </button>
          )}
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--doc-muted)]" aria-hidden />}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </article>
  );
}

function Evidence({ links, onOpenSources, onJumpToSection }: { links: EvidenceLink[]; onOpenSources?: (sourceId: string | null) => void; onJumpToSection?: (sectionId: string) => void }) {
  if (!links.length) return <p className="text-xs italic text-[var(--doc-muted)]">No linked passage</p>;
  return (
    <div className="flex flex-wrap items-start gap-1">
      {links.map((e, i) => (
        <EvidenceChip key={`${e.kind}:${e.ref}:${i}`} link={e} onOpenSources={onOpenSources} onJumpToSection={onJumpToSection} />
      ))}
    </div>
  );
}

const chipButton = "inline-flex min-h-11 max-w-full items-center gap-1 rounded-full bg-[var(--doc-accent-soft)] px-2.5 text-[11px] font-medium text-[var(--doc-ink)] hover:bg-[var(--go-soft)] sm:min-h-7";

function EvidenceChip({ link: e, onOpenSources, onJumpToSection }: { link: EvidenceLink; onOpenSources?: (sourceId: string | null) => void; onJumpToSection?: (sectionId: string) => void }) {
  const [open, setOpen] = useState(false);
  const label = evidenceLabel(e);
  const unverified = !e.verified || e.kind === "web";
  const tag = unverified ? <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">Unverified</span> : null;
  const href = webHref(e);
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={chipButton}>
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        {tag}
      </a>
    );
  }
  if (e.kind === "document" && e.ref !== "doc" && onJumpToSection) {
    return (
      <button type="button" onClick={() => onJumpToSection(e.ref)} className={chipButton}>
        <span className="truncate">{label}</span>
        {tag}
      </button>
    );
  }
  if ((e.kind === "passage" || e.kind === "source" || e.kind === "data" || e.kind === "requirement") && (e.quote || (e.sourceId && onOpenSources))) {
    return (
      <span className="inline-flex max-w-full flex-col">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={chipButton}>
          {open ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{label}</span>
          {tag}
        </button>
        {open && (
          <span className="mt-1 block rounded-lg border border-[var(--doc-line)] px-2.5 py-2 text-xs">
            {e.quote ? <q className="block leading-relaxed">{e.quote}</q> : <span className="text-[var(--doc-muted)]">No quote stored.</span>}
            {e.sourceId && onOpenSources && (
              <button type="button" onClick={() => onOpenSources(e.sourceId)} className="mt-1 flex min-h-11 items-center font-semibold text-[var(--go)] hover:underline sm:min-h-7">
                Open in Sources
              </button>
            )}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className={`${chipButton} hover:bg-[var(--doc-accent-soft)]`}>
      <span className="truncate">{label}</span>
      {tag}
    </span>
  );
}

// --- Disagreements ---------------------------------------------------------------------------------

function Disagreements({ items, onOpenSources, onJumpToSection }: { items: Disagreement[]; onOpenSources?: (sourceId: string | null) => void; onJumpToSection?: (sectionId: string) => void }) {
  return (
    <section aria-label="Disagreements" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">Where reviewers disagree ({items.length})</h3>
      <p className="text-xs text-[var(--doc-muted)]">No averaging: both views stand until a person decides.</p>
      {items.map((d) => (
        <article key={d.id} className="space-y-2 rounded-xl border border-[var(--doc-line)] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="min-w-0 flex-1 text-sm font-medium">{d.label}</p>
            {d.blocking && <span className={`${chip} ${TONE.bad}`}>Blocking</span>}
          </div>
          {/* Side by side where there is room; stacked on a phone. */}
          <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
            {d.positions.map((p) => (
              <div key={p.reviewer} className="min-w-0 space-y-1 rounded-lg bg-[var(--doc-accent-soft)]/60 px-2.5 py-2">
                <p className="text-xs font-semibold">{p.label || p.reviewer}</p>
                <p className="text-sm font-semibold text-[var(--go)]">{p.verdict ? p.verdict.replace(/_/g, " ") : p.score !== null ? `Score ${p.score}` : "No rating"}</p>
                {p.rationale && <p className="text-xs leading-relaxed">{p.rationale}</p>}
                {p.brief && (
                  <details className="text-xs text-[var(--doc-muted)]">
                    <summary className="flex min-h-11 cursor-pointer items-center sm:min-h-6">Brief</summary>
                    <p className="leading-relaxed">{p.brief}</p>
                  </details>
                )}
                <Evidence links={p.evidence} onOpenSources={onOpenSources} onJumpToSection={onJumpToSection} />
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

// --- Tables ----------------------------------------------------------------------------------------------

function OutcomeTableView({ table, onOpenSources }: { table: OutcomeTable; onOpenSources?: (sourceId: string | null) => void }) {
  const withEvidence = table.rows.some((r) => r.evidence.length > 0);
  const withStatus = table.rows.some((r) => r.status);
  return (
    <section aria-label={table.title} className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">{table.title}</h3>
      {/* Scrolls sideways inside the pane, never the page. */}
      <div className="max-h-[28rem] overflow-auto rounded-xl border border-[var(--doc-line)]">
        <table className="w-max min-w-full text-left text-xs">
          <thead className="sticky top-0 bg-[var(--doc-surface)]">
            <tr className="border-b border-[var(--doc-line)] text-[var(--doc-muted)]">
              {table.columns.map((c) => (
                <th key={c.key} scope="col" className="px-2.5 py-1.5 font-medium">
                  {c.label}
                </th>
              ))}
              {withStatus && (
                <th scope="col" className="px-2.5 py-1.5 font-medium">
                  Status
                </th>
              )}
              {withEvidence && (
                <th scope="col" className="px-2.5 py-1.5 font-medium">
                  Evidence
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} className="border-b border-[var(--doc-line)] align-top last:border-0">
                {table.columns.map((c) => (
                  <td key={c.key} className="max-w-[20rem] whitespace-pre-wrap px-2.5 py-1.5">
                    {r.cells[c.key] ?? ""}
                  </td>
                ))}
                {withStatus && <td className="px-2.5 py-1.5">{r.status?.replace(/_/g, " ") ?? ""}</td>}
                {withEvidence && (
                  <td className="min-w-[10rem] px-2.5 py-1.5">
                    <Evidence links={r.evidence} onOpenSources={onOpenSources} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Proposed changes --------------------------------------------------------------------------------------

function ChangeCard({
  change,
  headingFor,
  canApply,
  onApply,
  onDiscard,
}: {
  change: ProposedChange;
  headingFor: (key: string) => string;
  canApply: boolean;
  onApply: () => Promise<string | null>;
  onDiscard: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: "apply" | "discard", fn: () => Promise<string | null>) => {
    setBusy(kind);
    setError(null);
    const err = await fn();
    setBusy(null);
    if (err) setError(err);
  };
  const headings = changeHeadings(change, headingFor);
  const drafts = change.ops.filter((o): o is Extract<typeof o, { op: "replace_section_body" }> => o.op === "replace_section_body" && o.trace.length > 0);
  return (
    <section aria-label={change.title} className="space-y-2 rounded-xl border border-[var(--go-line,var(--doc-line))] px-3 py-2.5">
      <div className="space-y-0.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--go)]">Proposed change</p>
        <p className="text-sm font-semibold">{change.title}</p>
        {change.summary && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{change.summary}</p>}
      </div>
      {headings.length > 0 && <p className="text-xs">Sections: {headings.join(", ")}</p>}
      {drafts.map((d, i) => (
        <details key={`${d.sectionId ?? d.specKey}:${i}`} className="text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center gap-1.5 sm:min-h-8">
            {d.heading}
            {d.trace.some((t) => t.unsourced) && <span className={`${chip} ${TONE.wait}`}>{d.trace.filter((t) => t.unsourced).length} unsourced</span>}
          </summary>
          <ol className="mt-1 space-y-1.5">
            {d.trace.map((t, k) => (
              <li key={k} className="space-y-1">
                <p className={`text-sm leading-relaxed ${t.unsourced ? "rounded bg-amber-50 px-1 dark:bg-amber-950/50" : ""}`}>
                  {t.text} {t.unsourced && <span className={`${chip} ${TONE.wait}`}>Unsourced</span>}
                </p>
                {t.support.length > 0 && <Evidence links={t.support} />}
              </li>
            ))}
          </ol>
        </details>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={!canApply || !!busy}
          onClick={() => void act("apply", onApply)}
          title={canApply ? "Applies as one step you can undo; a version is saved first" : undefined}
          className="flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-40 sm:min-h-9"
        >
          {busy === "apply" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Apply to document
        </button>
        <button type="button" disabled={!canApply || !!busy} onClick={() => void act("discard", onDiscard)} className={`${pill} text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-40`}>
          {busy === "discard" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Discard
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
