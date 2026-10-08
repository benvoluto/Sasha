"use client";

// A human checkpoint (phase6-spec.md §8.1): the instructions and the role,
// Approve / Edit / Reject, what Edit may change (the outcome's value, or the
// restructure mapping's targets), the record fields the decision keeps and a
// note. A checkpoint with named signers takes one signature from each, in
// turn, showing who has signed. Once decided it shows who decided and when (and
// the mapping as decided). Shared by the document modal's Workflows tab and the
// canvas's run inspector.

import { useMemo, useState } from "react";
import { Loader2 } from "@/components/icons";
import {
  checkpointConfig,
  checkpointProblems,
  checkpointSignatures,
  continueBody,
  decidedTargets,
  decidedText,
  mappingGaps,
  mappingRows,
  pendingSigners,
  runPlan,
  type CheckpointDraft,
} from "@/components/editor/workflows-pane-model";
import { CHECKPOINT_VERDICTS, NO_HOME_HEADING, OUTCOME_BLOCKED, type CheckpointSignature, type CheckpointVerdict, type ContinueRequest, type RestructurePlan, type WorkflowRunView } from "@/lib/workflow/contract";

export type CheckpointSubmit = NonNullable<ContinueRequest["checkpoint"]>;

const VERDICT_LABELS: Record<CheckpointVerdict, string> = { approve: "Approve", edit: "Edit", reject: "Reject" };
const SUBMIT_LABELS: Record<CheckpointVerdict, string> = { approve: "Approve", edit: "Save edits and approve", reject: "Reject" };

const field = "w-full rounded-md border border-[var(--doc-line)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--doc-accent)]";
const small = "block text-xs font-medium text-[var(--doc-muted)]";

export function CheckpointPanel({
  run,
  nodeId,
  canDecide,
  sections = [],
  onSubmit,
  savedDraft = null,
  onDraftChange,
}: {
  run: WorkflowRunView;
  nodeId: string;
  /** False for a run opened read-only (history) or a person without run permission. */
  canDecide: boolean;
  /** The restructure target type's sections (key, heading) for the mapping's "Moves to". */
  sections?: Array<{ key: string; heading: string }>;
  /** Posts the decision; resolves to an error message, or null once it is recorded. */
  onSubmit: (checkpoint: CheckpointSubmit) => Promise<string | null>;
  /** A draft kept by the parent from an earlier mount (the person went to check a source and came back). */
  savedDraft?: CheckpointDraft | null;
  /** Every change to the draft, so the parent can keep it; null once the decision is recorded. */
  onDraftChange?: (draft: CheckpointDraft | null) => void;
}) {
  const config = checkpointConfig(run, nodeId);
  const decision = run.checkpoints?.[nodeId] ?? null;
  const plan = config?.editable === "rows" ? runPlan(run) : null;
  const values = (run.outcome?.values ?? []).filter((v) => v.key !== OUTCOME_BLOCKED);
  const signed = run.outputs?.[nodeId]?.signatures;
  const signatures = useMemo(() => checkpointSignatures({ outputs: { [nodeId]: { signatures: signed } } }, nodeId), [signed, nodeId]);
  // The mapping as the plan made it, with any earlier signer's moves laid over it.
  const original = useMemo(
    () => ({
      outcomeValue: run.outcome?.value ?? null,
      targets: signatures.reduce((t, g) => decidedTargets(t, g), Object.fromEntries((plan?.rows ?? []).map((r) => [r.id, r.target])) as Record<string, string | null>),
    }),
    [run.outcome?.value, plan, signatures],
  );
  const [draft, setOwnDraft] = useState<CheckpointDraft>(
    () => savedDraft ?? { verdict: "approve", note: "", outcomeValue: original.outcomeValue ?? "", targets: original.targets, record: { ...(signatures.at(-1)?.edits?.record ?? {}) } },
  );
  const setDraft = (next: (d: CheckpointDraft) => CheckpointDraft) => {
    const d = next(draft);
    setOwnDraft(d);
    onDraftChange?.(d);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  if (!config) return null;
  const waiting = run.steps[nodeId]?.status === "waiting";
  const pending = pendingSigners(config, signatures);
  // The signer chosen while still unsigned; with one signer left, that one.
  const chosen = pending.some((p) => p.key === draft.signer) ? draft.signer : pending.length === 1 ? pending[0].key : undefined;
  const signing: CheckpointDraft = { ...draft, signer: chosen };
  const problems = checkpointProblems(config, signing, {
    values: values.map((v) => v.key),
    rowIds: plan?.rows.map((r) => r.id),
    sectionKeys: sections.length ? sections.map((s) => s.key) : undefined,
  });
  const verdicts = CHECKPOINT_VERDICTS.filter((v) => v !== "edit" || config.editable !== "none");
  const set = (patch: Partial<CheckpointDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async () => {
    setTried(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(continueBody(nodeId, config, signing, original));
    setBusy(false);
    if (err) setError(err);
    else onDraftChange?.(null);
  };

  return (
    <section aria-label={`Checkpoint: ${config.role}`} className="space-y-3 rounded-xl border border-[var(--go-line,var(--doc-line))] bg-[var(--go-soft)]/50 p-3 text-sm">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--go)]">Checkpoint · {config.role}</p>
        {config.instructions && <p className="leading-relaxed">{config.instructions}</p>}
      </div>

      {plan && (
        <MappingTable
          plan={plan}
          sections={sections}
          // Once decided, the mapping as approved (the person's moves), not as the plan made it.
          targets={decision ? decidedTargets(original.targets, decision) : draft.targets}
          editing={waiting && canDecide && !decision && draft.verdict === "edit"}
          onTarget={(id, key) => set({ targets: { ...draft.targets, [id]: key } })}
        />
      )}

      {!decision && signatures.length > 0 && <SignatureList signatures={signatures} pending={pending.map((p) => p.label)} />}

      {decision ? (
        <div className="space-y-1 rounded-lg bg-[var(--doc-surface)] px-3 py-2">
          <p className="font-medium">{decidedText(decision)}</p>
          {decision.signatures?.length ? (
            <SignatureList signatures={decision.signatures} pending={[]} bare />
          ) : (
            decision.role && <p className="text-xs text-[var(--doc-muted)]">As {decision.role}</p>
          )}
          {Object.keys(decision.edits?.targets ?? {}).length > 0 && (
            <p className="text-xs text-[var(--doc-muted)]">
              Moved {Object.keys(decision.edits!.targets!).length} part{Object.keys(decision.edits!.targets!).length === 1 ? "" : "s"} at the checkpoint
            </p>
          )}
          {decision.edits?.outcomeValue && <p className="text-xs text-[var(--doc-muted)]">Changed the value to {values.find((v) => v.key === decision.edits?.outcomeValue)?.label ?? decision.edits.outcomeValue}</p>}
          {Object.entries(decision.edits?.record ?? {}).map(([k, v]) => (
            <p key={k} className="text-xs">
              <span className="text-[var(--doc-muted)]">{config.recordFields.find((f) => f.key === k)?.label ?? k}:</span> {v}
            </p>
          ))}
          {decision.note && !decision.signatures?.length && <p className="text-xs">“{decision.note}”</p>}
        </div>
      ) : !waiting ? (
        <p className="text-[var(--doc-muted)]">Not reached yet.</p>
      ) : !canDecide ? (
        <p className="text-[var(--doc-muted)]">Waiting for {pending.length && signatures.length ? pending.map((p) => p.label).join(" and ") : config.role}.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-3"
        >
          {pending.length > 0 && (
            <div className="space-y-1">
              <label htmlFor={`cp-signer-${nodeId}`} className={small}>
                Signing as
              </label>
              <select
                id={`cp-signer-${nodeId}`}
                value={signing.signer ?? ""}
                onChange={(e) => set({ signer: e.target.value || undefined })}
                className={`${field} min-h-11 sm:min-h-9`}
              >
                {pending.length > 1 && <option value="">Choose…</option>}
                {pending.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <fieldset>
            <legend className="sr-only">Decision</legend>
            <div className="flex flex-wrap gap-1.5">
              {verdicts.map((v) => (
                <label
                  key={v}
                  className={`flex min-h-11 cursor-pointer items-center rounded-full px-4 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--go)] sm:min-h-9 ${
                    draft.verdict === v ? (v === "reject" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-[var(--go-soft-strong)] text-[var(--go)]") : "text-[var(--doc-muted)] hover:bg-[var(--go-soft)]"
                  }`}
                >
                  <input type="radio" name={`verdict-${nodeId}`} value={v} checked={draft.verdict === v} onChange={() => set({ verdict: v })} className="sr-only" />
                  {VERDICT_LABELS[v]}
                </label>
              ))}
            </div>
          </fieldset>

          {draft.verdict === "edit" && config.editable === "outcome" && (
            <div className="space-y-1">
              <label htmlFor={`cp-value-${nodeId}`} className={small}>
                Outcome
              </label>
              <select id={`cp-value-${nodeId}`} value={draft.outcomeValue} onChange={(e) => set({ outcomeValue: e.target.value })} className={`${field} min-h-11 sm:min-h-9`}>
                {values.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {draft.verdict === "edit" && config.editable === "rows" && <p className="text-xs text-[var(--doc-muted)]">Change where parts go in the table above, then save.</p>}

          {draft.verdict !== "reject" &&
            config.recordFields.map((f) => (
              <div key={f.key} className="space-y-1">
                <label htmlFor={`cp-${nodeId}-${f.key}`} className={small}>
                  {f.label}
                  {f.required ? <span aria-hidden> *</span> : <span className="font-normal"> (optional)</span>}
                </label>
                <input
                  id={`cp-${nodeId}-${f.key}`}
                  required={f.required}
                  aria-required={f.required}
                  value={draft.record[f.key] ?? ""}
                  onChange={(e) => set({ record: { ...draft.record, [f.key]: e.target.value } })}
                  className={`${field} min-h-11 sm:min-h-9`}
                />
              </div>
            ))}

          <div className="space-y-1">
            <label htmlFor={`cp-note-${nodeId}`} className={small}>
              Note <span className="font-normal">(optional)</span>
            </label>
            <textarea id={`cp-note-${nodeId}`} rows={2} value={draft.note} onChange={(e) => set({ note: e.target.value })} className={field} />
          </div>

          {tried && problems.length > 0 && (
            <ul role="alert" className="list-disc space-y-0.5 pl-5 text-xs text-red-700 dark:text-red-300">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className={`flex min-h-11 items-center gap-1.5 rounded-md px-4 text-sm font-semibold disabled:opacity-50 sm:min-h-9 ${draft.verdict === "reject" ? "bg-red-700 text-white" : "bg-[var(--doc-accent)] text-[var(--doc-on-accent)]"}`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {SUBMIT_LABELS[draft.verdict]}
          </button>
        </form>
      )}
    </section>
  );
}

/** Who has signed a checkpoint with named signers (each verdict, who and when, their note), and who is still to sign. */
function SignatureList({ signatures, pending, bare = false }: { signatures: CheckpointSignature[]; pending: string[]; bare?: boolean }) {
  return (
    <div className={bare ? "space-y-1" : "space-y-1 rounded-lg bg-[var(--doc-surface)] px-3 py-2"}>
      <ul className="space-y-1 text-xs">
        {signatures.map((g) => (
          <li key={g.signer}>
            <span className="font-medium">{g.label}:</span> {decidedText(g)}
            {g.note && <span className="block text-[var(--doc-muted)]">“{g.note}”</span>}
          </li>
        ))}
      </ul>
      {pending.length > 0 && <p className="text-xs text-[var(--doc-muted)]">Still to sign: {pending.join(", ")}</p>}
    </div>
  );
}

/** The restructure mapping: each part, where it moves (a select while editing) and why. Scrolls sideways inside its box. */
export function MappingTable({
  plan,
  sections,
  targets,
  editing,
  onTarget,
}: {
  plan: RestructurePlan;
  sections: Array<{ key: string; heading: string }>;
  targets: Record<string, string | null>;
  editing: boolean;
  onTarget: (rowId: string, key: string | null) => void;
}) {
  const rows = mappingRows(plan, sections, targets);
  const gaps = mappingGaps(plan, sections, targets);
  const heading = new Map(sections.map((s) => [s.key, s.heading]));
  // Keys the plan uses that the type list doesn't know (the catalog hasn't loaded, or the type changed).
  const options = [...sections, ...plan.rows.flatMap((r) => (r.target && !heading.has(r.target) ? [{ key: r.target, heading: r.target }] : []))];
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-[var(--doc-muted)]">
        Mapping to {plan.targetTitle || plan.targetType} ({plan.mode === "rewrite" ? "rewrite" : "merge"})
      </p>
      <div className="overflow-x-auto rounded-lg border border-[var(--doc-line)] bg-[var(--doc-surface)]">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--doc-line)] text-xs text-[var(--doc-muted)]">
              <th scope="col" className="px-3 py-2 font-medium">
                Part
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Moves to
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[var(--doc-line)] align-top last:border-0">
                <td className="max-w-[16rem] px-3 py-2">
                  <span className="block font-medium">{r.part}</span>
                  {r.excerpt && <span className="line-clamp-2 text-xs text-[var(--doc-muted)]">{r.excerpt}</span>}
                </td>
                <td className="px-3 py-2">
                  {editing ? (
                    <select
                      aria-label={`Where “${r.part}” moves`}
                      value={r.target ?? ""}
                      onChange={(e) => onTarget(r.id, e.target.value || null)}
                      className={`${field} min-h-11 min-w-[11rem] sm:min-h-9`}
                    >
                      <option value="">No home (keep under “{NO_HOME_HEADING}”)</option>
                      {options.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.heading}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={r.target === null ? "text-[var(--doc-muted)]" : ""}>{r.movesTo}</span>
                  )}
                </td>
                <td className="max-w-[16rem] px-3 py-2 text-xs text-[var(--doc-muted)]">{r.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {gaps.length > 0 && (
        <p className="text-xs text-[var(--doc-muted)]">
          Will be added empty: <span className="text-[var(--doc-ink)]">{gaps.join(", ")}</span>
        </p>
      )}
    </div>
  );
}
