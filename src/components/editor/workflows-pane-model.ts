// Pure logic for the Workflows tab (workflows-pane.tsx, phase6-spec.md §8.1):
// grouping the workflows a document can run, the start form's checks, how
// often to poll a run and when to continue a paused one, the step list with
// loop progress, the outcome card's lines (signature, scores, computed
// results), findings by severity with their evidence chips, the checkpoint
// form's checks, the restructure mapping table, and a replace_lines change's
// line-by-line choices (the resume Tailor step, tailor-spec.md §6.2). Client-safe.

import { CHECKPOINT_NODE_TYPE, configFor, NODE_SPEC_INDEX } from "@/lib/workflow/registry";
import type { CheckpointConfig } from "@/lib/workflow/node-specs/core";
import {
  CHANGED_LINE_KIND,
  NO_HOME_HEADING,
  SEVERITIES,
  type AvailableWorkflow,
  type ChangedLine,
  type ChangeResult,
  type ChangeResultRequest,
  type CheckpointEdits,
  type CheckpointSignature,
  type CheckpointVerdict,
  type ComputeResult,
  type EvidenceLink,
  type DocumentChangeOp,
  type Finding,
  type GateItem,
  type LineResult,
  type Outcome,
  type ProposedChange,
  type ReplaceLine,
  type RestructurePlan,
  type RunBrief,
  type RunStatus,
  type ScoreSummary,
  type Severity,
  type StartRunRequest,
  type StepProgressItem,
  type WorkflowRunView,
} from "@/lib/workflow/contract";
import { retryAfterMs } from "@/lib/limits/client";
import type { AppliedChange } from "./apply-workflow-change";
import { droppedWarning } from "@/lib/workflow/restructure";

// --- The list ---------------------------------------------------------------------

export type WorkflowGroup = { kind: AvailableWorkflow["kind"]; title: string; items: AvailableWorkflow[] };

const GROUP_TITLES: Record<AvailableWorkflow["kind"], string> = {
  type: "For this type",
  generic: "For any document",
  team: "Your team's workflows",
};
const GROUP_ORDER: AvailableWorkflow["kind"][] = ["type", "generic", "team"];

/** The available workflows as the tab lists them: this type's, then the generic ones, then the team's. Empty groups are left out; order within a group is the server's. */
export function groupAvailable(available: AvailableWorkflow[]): WorkflowGroup[] {
  return GROUP_ORDER.map((kind) => ({ kind, title: GROUP_TITLES[kind], items: available.filter((w) => w.kind === kind) })).filter((g) => g.items.length > 0);
}

/** "Signed off by: Supervisor", or null for a workflow with no checkpoint. */
export function checkpointText(w: Pick<AvailableWorkflow, "checkpoint">): string | null {
  return w.checkpoint ? `Signed off by: ${w.checkpoint.role}` : null;
}

const STATUS_TEXT: Record<RunStatus, string> = {
  running: "Running",
  awaiting_review: "Waiting for review",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
  superseded: "Replaced by a later run",
};

/** A run's status in words. Rows from before Phase 6 may still say "draft", which reads as complete. */
export function runStatusText(status: RunStatus | "draft"): string {
  return status === "draft" ? STATUS_TEXT.complete : (STATUS_TEXT[status] ?? status);
}

export type StatusTone = "busy" | "ok" | "wait" | "bad" | "quiet";

export function statusTone(status: RunStatus | "draft"): StatusTone {
  if (status === "running") return "busy";
  if (status === "complete" || status === "draft") return "ok";
  if (status === "awaiting_review" || status === "paused") return "wait";
  if (status === "failed") return "bad";
  return "quiet";
}

/** Where an outcome stands: "Advisory" until signed, then "Signed" or "Rejected". */
export function signatureState(o: Pick<Outcome, "advisory" | "verdict"> | null | undefined): "Advisory" | "Signed" | "Rejected" | null {
  if (!o) return null;
  if (o.verdict === "reject") return "Rejected";
  return o.advisory ? "Advisory" : "Signed";
}

/** A run brief's outcome in one line: "Gaps found · Advisory", or the status while there is none. */
export function briefText(r: Pick<RunBrief, "status" | "outcome">): string {
  if (!r.outcome || r.outcome.value === undefined) return runStatusText(r.status);
  const label = r.outcome.valueLabel || (r.outcome.value === null ? "No outcome" : r.outcome.value);
  return `${label} · ${signatureState(r.outcome)}`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// --- Starting a run ------------------------------------------------------------------

export type StartForm = { targetType: string; mode: "merge" | "rewrite"; acknowledged: boolean };

export const RESTRUCTURE_KEY = "restructure";

/** Opened from the classifier chip: open the restructure workflow with this type chosen. */
export type WorkflowsPrefill = { workflowKey: string; targetType: string | null };

export function needsForm(w: Pick<AvailableWorkflow, "params" | "enabled" | "acknowledge">): boolean {
  return w.params.length > 0 || (!w.enabled && !!w.acknowledge);
}

/** Why Run is unavailable, or null when the run can start. */
export function startBlocker(w: Pick<AvailableWorkflow, "params" | "enabled" | "acknowledge" | "disabledReason">, form: StartForm): string | null {
  if (!w.enabled) {
    if (!w.acknowledge) return w.disabledReason ?? "This workflow is turned off for this document.";
    if (!form.acknowledged) return "Tick the box to run it anyway.";
  }
  if (w.params.includes("targetType") && !form.targetType) return "Choose a type to restructure to.";
  return null;
}

/** The POST body for starting `w` with the form's choices. */
export function startRequest(w: Pick<AvailableWorkflow, "id" | "version" | "params" | "enabled" | "acknowledge">, form: StartForm): StartRunRequest {
  const params: NonNullable<StartRunRequest["params"]> = {};
  if (w.params.includes("targetType") && form.targetType) params.targetType = form.targetType;
  if (w.params.includes("mode")) params.mode = form.mode;
  if (!w.enabled && w.acknowledge && form.acknowledged) params.acknowledge = [w.acknowledge.key];
  return { workflowId: w.id, version: w.version, ...(Object.keys(params).length ? { params } : {}) };
}

// --- Polling and continuing -----------------------------------------------------------

export const POLL_RUNNING_MS = 2000;
export const POLL_REVIEW_MS = 10_000;
/** The longest wait between polls, after repeated failures. */
export const POLL_MAX_MS = 60_000;
/** Automatic continues of a run paused at the time budget, per run per session. */
export const AUTO_CONTINUE_MAX = 10;

/** How long until the run view polls again (later after `failures` failed polls in a row), or null to stop. */
export function pollDelay(status: RunStatus, failures = 0): number | null {
  const base = status === "running" ? POLL_RUNNING_MS : status === "awaiting_review" ? POLL_REVIEW_MS : null;
  if (base === null) return null;
  // After failed polls, back off (doubling, at most POLL_MAX_MS) but keep polling.
  return Math.min(base * 2 ** Math.min(Math.max(failures, 0), 5), POLL_MAX_MS);
}

/** Continue on its own: a run paused at the time budget, at most AUTO_CONTINUE_MAX times. A person's pause waits for the Continue button. */
export function shouldAutoContinue(run: Pick<WorkflowRunView, "status" | "pause_reason">, continuedSoFar: number): boolean {
  return run.status === "paused" && run.pause_reason === "budget" && continuedSoFar < AUTO_CONTINUE_MAX;
}

/**
 * How long to hold off before the next automatic continue after `error`, or
 * null when it wasn't the limiter's 429. A refused continue didn't continue
 * the run, so it doesn't count toward AUTO_CONTINUE_MAX; trying again at once
 * only spent the remaining tries on more 429s.
 */
export function autoContinueWait(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; body?: unknown; retryAfter?: unknown };
  if (typeof e.status !== "number") return null;
  return retryAfterMs(e.status, e.body, typeof e.retryAfter === "string" ? e.retryAfter : null);
}

// --- Steps --------------------------------------------------------------------------------

/** One loop item under a step row (a section being drafted), with its state in words. */
export type StepItemRow = { key: string; label: string; state: StepProgressItem["state"]; stateText: string; sectionId: string | null };

export type StepRow = { id: string; label: string; type: string; status: string; note: string; error: string; progress: string | null; items: StepItemRow[] };

const LOOP_UNIT: Record<string, string> = { "draft.section": "sections", "restructure.rewrite": "sections" };

export const nodeLabel = (n: { type: string; label?: string }) => n.label || NODE_SPEC_INDEX[n.type]?.label || n.type;

/** "3 of 7 sections" for a looping node's progress. */
export function progressText(type: string, p: { done: number; total: number } | undefined): string | null {
  if (!p || !p.total) return null;
  return `${p.done} of ${p.total} ${LOOP_UNIT[type] ?? "items"}`;
}

const ITEM_STATE_TEXT: Record<StepProgressItem["state"], string> = { pending: "Not started", running: "In progress", done: "Done", failed: "Failed", skipped: "Skipped" };

/** A looping step's items (at most MAX_PROGRESS_ITEMS, as the engine lists them); none for a step that doesn't loop. */
export function stepItemRows(items: StepProgressItem[] | undefined): StepItemRow[] {
  return (items ?? []).map((it, i) => ({ key: `${i}:${it.sectionId ?? it.label}`, label: it.label, state: it.state, stateText: ITEM_STATE_TEXT[it.state] ?? it.state, sectionId: it.sectionId ?? null }));
}

/** The run's steps in graph order, with loop progress and each item's state. */
export function stepRows(run: Pick<WorkflowRunView, "graph" | "steps">): StepRow[] {
  return run.graph.nodes.map((n) => {
    const s = run.steps[n.id];
    return { id: n.id, label: nodeLabel(n), type: n.type, status: s?.status ?? "pending", note: s?.note ?? "", error: s?.error ?? "", progress: progressText(n.type, s?.progress), items: stepItemRows(s?.progress?.items) };
  });
}

/**
 * The canvas's selection from its URL: ?workflow=…&version=…, with
 * ?workflowId= read as an alias of ?workflow= (links built from run records use it).
 */
export function canvasSelection(search: string): { workflow?: string; version?: number } {
  const p = new URLSearchParams(search);
  const workflow = p.get("workflow") || p.get("workflowId") || undefined;
  const v = p.get("version");
  const version = v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
  return { workflow, version };
}

/** "4 of 9 steps done". */
export function stepsDoneText(rows: StepRow[]): string {
  const done = rows.filter((r) => r.status === "done" || r.status === "skipped").length;
  return `${done} of ${rows.length} steps done`;
}

// --- Outcome card --------------------------------------------------------------------------

/** "Signed by a@b.c as Supervisor, Oct 8, 2026, 3:04 PM", "Rejected by …", or null while advisory and undecided. */
export function signatureText(o: Pick<Outcome, "advisory" | "verdict" | "signedBy" | "signedAt" | "signedRole">, fmt: (iso: string | null) => string = formatWhen): string | null {
  if (o.verdict === "reject") return `Rejected by ${o.signedBy ?? "the reviewer"}${o.signedRole ? ` as ${o.signedRole}` : ""}${o.signedAt ? `, ${fmt(o.signedAt)}` : ""}`;
  if (o.advisory || !o.signedBy) return null;
  return `Signed by ${o.signedBy}${o.signedRole ? ` as ${o.signedRole}` : ""}${o.signedAt ? `, ${fmt(o.signedAt)}` : ""}`;
}

/** "Median 4 · range 3 to 6 · mean × 10: 43". */
export function scoreText(s: ScoreSummary): string {
  const range = s.min === s.max ? `all ${s.min}` : `range ${s.min} to ${s.max}`;
  return [`Median ${s.median}`, range, s.meanTimes10 !== null ? `mean × 10: ${s.meanTimes10}` : ""].filter(Boolean).join(" · ");
}

export type ComputedLine = { key: string; label: string; status: "ok" | "failed" | "unknown"; text: string; estimate: boolean; detail: string };

export function computedLine(c: ComputeResult): ComputedLine {
  const status = c.ok === true ? "ok" : c.ok === false ? "failed" : "unknown";
  const text = c.ok === null ? (c.actual ? `${c.actual} (no limit to compare)` : "Couldn't compute") : c.expected ? `${c.actual} (expected ${c.expected})` : c.actual;
  return { key: c.key, label: c.label, status, text, estimate: c.approximate, detail: c.detail };
}

/** A blocked outcome's missing inputs, each with the help the gate gives for it (from the gate step's report, when it is there). */
export function missingInputs(run: Pick<WorkflowRunView, "outputs">, outcome: Pick<Outcome, "missing">): Array<{ label: string; help: string }> {
  const help = new Map<string, string>();
  for (const out of Object.values(run.outputs ?? {})) {
    for (const v of Object.values(out ?? {})) {
      const missing = (v as { missing?: unknown } | null)?.missing;
      if (!Array.isArray(missing)) continue;
      for (const item of missing as Partial<GateItem>[]) if (item && typeof item.label === "string" && item.help) help.set(item.label, item.help);
    }
  }
  return outcome.missing.map((label) => ({ label, help: help.get(label) ?? "" }));
}

// --- Findings --------------------------------------------------------------------------------

export const SEVERITY_LABELS: Record<Severity, string> = { blocking: "Blocking", major: "Major", minor: "Minor", info: "Info" };

/** Findings grouped by severity, most severe first; empty groups left out. */
export function findingsBySeverity(findings: Finding[]): Array<{ severity: Severity; label: string; items: Finding[] }> {
  return SEVERITIES.map((severity) => ({ severity, label: SEVERITY_LABELS[severity], items: findings.filter((f) => f.severity === severity) })).filter((g) => g.items.length > 0);
}

/** Findings get Accept and Dismiss only in workflows with no checkpoint (the author owns them there). */
export function findingsRespondable(run: Pick<WorkflowRunView, "graph">): boolean {
  return !run.graph.nodes.some((n) => n.type === CHECKPOINT_NODE_TYPE);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The short text on an evidence chip. */
export function evidenceLabel(e: EvidenceLink): string {
  switch (e.kind) {
    case "passage":
      return [e.label || "Source", e.page !== null ? `p. ${e.page}` : "", e.ref].filter(Boolean).join(" · ");
    case "source":
      return e.label || "Source";
    case "web":
      return e.label || hostOf(e.ref);
    case "requirement":
      return e.label || e.ref;
    case "document":
      return e.label || (e.ref === "doc" ? "The document" : "Section");
    case "note":
      return e.ref === "notes" ? "Notes" : e.label ? `Notes: ${e.label}` : "Section notes";
    case "data":
      return e.label || "Data table";
    case "item":
      return e.label ? `${e.ref}: ${e.label}` : `Item ${e.ref}`;
  }
}

/** Whether a link is safe to open as a web link (http or https only). */
export function webHref(e: EvidenceLink): string | null {
  if (e.kind !== "web") return null;
  try {
    const u = new URL(e.ref);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

// --- Checkpoint ---------------------------------------------------------------------------------

/** The checkpoint nodes waiting for a person, in graph order. */
export function waitingCheckpoints(run: Pick<WorkflowRunView, "graph" | "steps">): Array<{ id: string; label: string; config: CheckpointConfig }> {
  const spec = NODE_SPEC_INDEX[CHECKPOINT_NODE_TYPE];
  return run.graph.nodes
    .filter((n) => n.type === CHECKPOINT_NODE_TYPE && run.steps[n.id]?.status === "waiting")
    .map((n) => ({ id: n.id, label: nodeLabel(n), config: (spec ? configFor(spec, n.config) : n.config) as CheckpointConfig }));
}

/** A checkpoint node's config, parsed (defaults when it doesn't parse). */
export function checkpointConfig(run: Pick<WorkflowRunView, "graph">, nodeId: string): CheckpointConfig | null {
  const n = run.graph.nodes.find((x) => x.id === nodeId);
  const spec = NODE_SPEC_INDEX[CHECKPOINT_NODE_TYPE];
  if (!n || !spec) return null;
  return configFor(spec, n.config) as CheckpointConfig;
}

export type CheckpointDraft = {
  verdict: CheckpointVerdict;
  note: string;
  outcomeValue: string;
  targets: Record<string, string | null>;
  record: Record<string, string>;
  /** At a checkpoint with named signers: the signer key the person signs as. */
  signer?: string;
};

/** The signatures a checkpoint with named signers has collected while it waits (its output's `signatures`). */
export function checkpointSignatures(run: Pick<WorkflowRunView, "outputs">, nodeId: string): CheckpointSignature[] {
  const list = run.outputs?.[nodeId]?.signatures;
  return Array.isArray(list) ? (list as CheckpointSignature[]).filter((x) => x && typeof x.signer === "string" && typeof x.by === "string") : [];
}

/** The named signers still to sign, in config order. */
export function pendingSigners(config: Pick<CheckpointConfig, "signers">, signatures: CheckpointSignature[]): CheckpointConfig["signers"] {
  return config.signers.filter((x) => !signatures.some((g) => g.signer === x.key));
}

/** The mapping as decided: the plan's targets with the checkpoint's edits laid over them. */
export function decidedTargets(original: Record<string, string | null>, decision: { edits: CheckpointEdits | null } | null): Record<string, string | null> {
  return { ...original, ...(decision?.edits?.targets ?? {}) };
}

/**
 * What stops the decision being sent, or [] when it can go: Edit only when the
 * checkpoint allows it, an edited value from the outcome's values, row targets
 * only to the target type's sections, and every required record field filled
 * (for approve and edit; a rejection needs no record). With named signers,
 * the person says which one they sign as.
 */
export function checkpointProblems(config: CheckpointConfig, draft: CheckpointDraft, opts: { values?: string[]; rowIds?: string[]; sectionKeys?: string[] } = {}): string[] {
  const out: string[] = [];
  if (config.signers.length && !config.signers.some((x) => x.key === draft.signer)) out.push("Choose who you are signing as.");
  if (draft.verdict === "edit" && config.editable === "none") out.push("This checkpoint can't be edited; approve or reject it.");
  if (draft.verdict === "edit" && config.editable === "outcome" && opts.values && !opts.values.includes(draft.outcomeValue)) out.push("Choose one of the outcome's values.");
  if (draft.verdict === "edit" && config.editable === "rows") {
    const rows = new Set(opts.rowIds ?? []);
    const keys = new Set(opts.sectionKeys ?? []);
    for (const [id, key] of Object.entries(draft.targets)) {
      if (opts.rowIds && !rows.has(id)) out.push(`Row ${id} isn't in the plan.`);
      else if (key !== null && opts.sectionKeys && !keys.has(key)) out.push(`Row ${id} moves to a section the type doesn't have.`);
    }
  }
  if (draft.verdict !== "reject") {
    for (const f of config.recordFields) if (f.required && !draft.record[f.key]?.trim()) out.push(`Fill in “${f.label}”.`);
  }
  return out;
}

/** The ContinueRequest's checkpoint for the draft: only the edits the verdict uses. */
export function continueBody(nodeId: string, config: CheckpointConfig, draft: CheckpointDraft, original: { outcomeValue: string | null; targets: Record<string, string | null> }) {
  const edits: CheckpointEdits = {};
  if (draft.verdict === "edit" && config.editable === "outcome" && draft.outcomeValue && draft.outcomeValue !== original.outcomeValue) edits.outcomeValue = draft.outcomeValue;
  if (draft.verdict === "edit" && config.editable === "rows") {
    const changed = Object.fromEntries(Object.entries(draft.targets).filter(([id, key]) => original.targets[id] !== key));
    if (Object.keys(changed).length) edits.targets = changed;
  }
  const record = Object.fromEntries(
    Object.entries(draft.record)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v),
  );
  if (draft.verdict !== "reject" && Object.keys(record).length) edits.record = record;
  return {
    nodeId,
    verdict: draft.verdict,
    note: draft.note.trim(),
    excluded: [] as number[],
    ...(Object.keys(edits).length ? { edits } : {}),
    ...(config.signers.length && draft.signer ? { signer: draft.signer } : {}),
  };
}

/** "Decided by a@b.c, Oct 8, 2026, 3:04 PM". */
export function decidedText(d: { by: string; at: string; verdict: CheckpointVerdict }, fmt: (iso: string | null) => string = formatWhen): string {
  const verb = d.verdict === "reject" ? "Rejected" : d.verdict === "edit" ? "Edited and approved" : "Approved";
  return `${verb}. Decided by ${d.by}, ${fmt(d.at)}`;
}

// --- Restructure mapping ----------------------------------------------------------------------------

function isPlan(v: unknown): v is RestructurePlan {
  const p = v as Partial<RestructurePlan> | null;
  return !!p && typeof p === "object" && Array.isArray(p.rows) && Array.isArray(p.blockHashes) && typeof p.targetType === "string";
}

/** The restructure plan a run made (the restructure.plan step's `plan` output), if any. */
export function runPlan(run: Pick<WorkflowRunView, "outputs">): RestructurePlan | null {
  for (const out of Object.values(run.outputs ?? {})) for (const v of Object.values(out ?? {})) if (isPlan(v)) return v;
  return null;
}

export type MappingRow = { id: string; part: string; excerpt: string; target: string | null; movesTo: string; why: string };

/** The mapping table's rows: each part, where it moves (with the person's edits) and why. */
export function mappingRows(plan: RestructurePlan, sections: Array<{ key: string; heading: string }>, targets: Record<string, string | null> = {}): MappingRow[] {
  const heading = new Map(sections.map((s) => [s.key, s.heading]));
  return plan.rows.map((r) => {
    const target = r.id in targets ? targets[r.id] : r.target;
    return {
      id: r.id,
      part: r.heading ?? "Text before the first heading",
      excerpt: r.excerpt,
      target,
      movesTo: target === null ? `Kept word for word under “${NO_HOME_HEADING}”` : (heading.get(target) ?? target),
      why: r.reason,
    };
  });
}

/** Target sections nothing maps to, as headings: "Will be added empty". */
export function mappingGaps(plan: RestructurePlan, sections: Array<{ key: string; heading: string }>, targets: Record<string, string | null> = {}): string[] {
  // The type's outline hasn't loaded: the plan's own gaps, by key.
  if (!sections.length) return plan.gaps;
  const used = new Set(plan.rows.map((r) => (r.id in targets ? targets[r.id] : r.target)).filter((k): k is string => !!k));
  return sections.filter((s) => !used.has(s.key)).map((s) => s.heading);
}

/**
 * The headings the plan removes because they hold no text of their own (Phase 8):
 * "These headings hold no text of their own and will be removed: …", or "" when
 * none (and for plans stored before Phase 8, which have no `dropped`).
 */
export function mappingDropped(plan: Pick<RestructurePlan, "dropped">): string {
  return droppedWarning(plan.dropped);
}

/** The removal warnings of a change's restructure ops, shown before it is applied. */
export function changeWarnings(change: ProposedChange): string[] {
  return change.ops.flatMap((op) => (op.op === "restructure" && mappingDropped(op.plan) ? [mappingDropped(op.plan)] : []));
}

// --- Proposed changes ----------------------------------------------------------------------------------

/** Proposed changes nobody has applied, discarded or skipped yet. */
export function pendingChanges(run: Pick<WorkflowRunView, "proposed" | "changes">): ProposedChange[] {
  return (run.proposed ?? []).filter((p) => !run.changes?.[p.id]);
}

/** The section headings a change touches, for its preview (restructure targets named through `headingFor`). */
export function changeHeadings(change: ProposedChange, headingFor: (key: string) => string = (k) => k): string[] {
  const out: string[] = [];
  for (const op of change.ops) {
    if (op.op === "replace_section_body") out.push(op.heading);
    else if (op.op === "replace_lines") out.push(...op.lines.map((l) => l.heading));
    else out.push(...op.plan.rows.map((r) => r.target).filter((k): k is string => !!k).map(headingFor), ...op.plan.gaps.map(headingFor));
  }
  return [...new Set(out)];
}

// --- Line-by-line changes (resume Tailor step) ---------------------------------------------------------

/** A change's proposed lines (every replace_lines op's, in order), or null when it has none: the pane then shows the all-or-nothing card. */
export function lineChange(change: Pick<ProposedChange, "ops">): ReplaceLine[] | null {
  const lines = change.ops.flatMap((op) => (op.op === "replace_lines" ? op.lines : []));
  return change.ops.some((op) => op.op === "replace_lines") ? lines : null;
}

/** The change's ops with only the ticked lines, for the editor to apply (other ops unchanged). */
export function selectedOps(change: Pick<ProposedChange, "ops">, selected: ReadonlySet<string>): DocumentChangeOp[] {
  return change.ops.map((op) => (op.op === "replace_lines" ? { ...op, lines: op.lines.filter((l) => selected.has(l.id)) } : op));
}

export const LINE_REJECTED = "Not kept by the author";
const LINE_NOT_APPLIED = "Not applied";

/**
 * Every line's result for the `changes` POST, in the change's order: the
 * editor's result for each ticked line, rejected for each unticked one. A
 * ticked line the editor didn't report counts as skipped.
 */
export function lineResults(change: Pick<ProposedChange, "ops">, selected: ReadonlySet<string>, applied: LineResult[]): LineResult[] {
  const byId = new Map(applied.map((r) => [r.lineId, r]));
  return (lineChange(change) ?? []).map((l) =>
    !selected.has(l.id) ? { lineId: l.id, result: "rejected", detail: LINE_REJECTED } : (byId.get(l.id) ?? { lineId: l.id, result: "skipped", detail: LINE_NOT_APPLIED }),
  );
}

/** A line change applied in the editor whose result isn't recorded yet (the POST failed, or the save after it didn't land): a retry records it, never applies it again. */
export type AppliedLines = { selected: ReadonlySet<string>; out: AppliedChange };

/** What to do once the author applied (or kept none of) a change's lines. */
export type LineRecordPlan = {
  /** The changes POST, or null to send nothing (then `error` says why). */
  post: ChangeResultRequest | null;
  error: string | null;
  /** Back to the editor once recorded; never while the run waits on the change (it goes on in the pane). */
  close: boolean;
  /**
   * The pane's status line once recorded, whenever the pane stays open (the card and its
   * focused button unmount, so focus moves to it); null when it closes or nothing is posted.
   */
  status: string | null;
  /** The status describes the waiting run going on ("scoring…"): shown only while the run is still going. */
  ongoing: boolean;
};

export const LINES_UNSAVED = "The lines are changed in the editor, but the document hasn't saved, so the run can't score them yet. Resolve the save problem, then record the result.";
export const LINES_KEPT_NONE = "Kept none of the lines; scoring the resume as it is…";
export const LINES_DISCARDED = "Kept none of the lines; the change is recorded as discarded.";
export const LINES_STALE = "No lines could be applied: each was edited since the run.";
export const LINES_STALE_WAITING = "No lines could be applied (each was edited since the run); scoring the resume as it is…";

/** Nothing kept: while the run waits it goes on with the resume as it is; otherwise the discard is the whole story. */
const discardedStatus = (waiting: boolean) => ({ status: waiting ? LINES_KEPT_NONE : LINES_DISCARDED, ongoing: waiting });

/**
 * Pure: the record for a replace_lines change. Nothing ticked: discarded, every
 * line rejected. A refused apply (result null) posts nothing; nor does an apply
 * whose save didn't land, since the run would score the stored document
 * without the lines. Otherwise the editor's result with every line's outcome.
 */
export function lineRecord(change: Pick<ProposedChange, "id" | "ops">, selected: ReadonlySet<string>, out: AppliedChange | null, waiting: boolean): LineRecordPlan {
  if (!selected.size) {
    return { post: { changeId: change.id, result: "discarded", detail: "Kept none of the proposed lines.", lines: lineResults(change, new Set(), []) }, error: null, close: false, ...discardedStatus(waiting) };
  }
  if (!out || out.result === null) return { post: null, error: out?.detail || "The lines weren't applied.", close: false, status: null, ongoing: false };
  if (out.unsaved) return { post: null, error: LINES_UNSAVED, close: false, status: null, ongoing: false };
  const kept = (out.lines ?? []).filter((l) => l.result === "accepted").length;
  const post: ChangeResultRequest = { changeId: change.id, result: out.result, detail: out.detail.slice(0, 1000), lines: lineResults(change, selected, out.lines ?? []) };
  // Every ticked line was stale: say so, never "Applied 0 lines".
  if (out.result !== "applied" || !kept) return { post, error: null, close: false, status: waiting ? LINES_STALE_WAITING : LINES_STALE, ongoing: waiting };
  return { post, error: null, close: !waiting, status: waiting ? `Applied ${kept} line${kept === 1 ? "" : "s"}; scoring the tailored resume…` : null, ongoing: waiting };
}

/** Pure: the record for Discard: every line rejected; the waiting run goes on with the resume as it is. */
export function lineDiscard(change: Pick<ProposedChange, "id" | "ops">, waiting: boolean): LineRecordPlan {
  return { post: { changeId: change.id, result: "discarded", detail: "", lines: lineResults(change, new Set(), []) }, error: null, close: false, ...discardedStatus(waiting) };
}

/** "4 of 6 lines selected". */
export function lineSelectionText(selected: number, total: number): string {
  return `${selected} of ${total} line${total === 1 ? "" : "s"} selected`;
}

/** The apply button: "Apply 4 lines", or "Keep none and continue" with nothing ticked. */
export function applyLinesLabel(selected: number): string {
  return selected ? `Apply ${selected} line${selected === 1 ? "" : "s"}` : "Keep none and continue";
}

/** A requirement key's text, from the run's step.extract items (by id); the key itself when it isn't found. */
export function requirementLabel(run: Pick<WorkflowRunView, "graph" | "outputs">, key: string): string {
  for (const n of run.graph.nodes) {
    if (n.type !== "step.extract") continue;
    const items = run.outputs?.[n.id]?.items;
    if (!Array.isArray(items)) continue;
    const hit = (items as Array<{ id?: unknown; fields?: Record<string, unknown> }>).find((it) => it && it.id === key);
    if (!hit?.fields) continue;
    const fields = hit.fields;
    const text = [fields.requirement, ...Object.values(fields)].find((v): v is string => typeof v === "string" && !!v.trim());
    if (text) return text;
  }
  return key;
}

const isChangedLine = (v: unknown): v is ChangedLine => !!v && typeof v === "object" && (v as { kind?: unknown }).kind === CHANGED_LINE_KIND && typeof (v as { id?: unknown }).id === "string";

/** The changed lines a checkpoint lists: from its pending_items while it waits, its items output once decided (a list input may arrive nested one level). */
export function changedLinesFor(run: Pick<WorkflowRunView, "steps" | "outputs">, nodeId: string): ChangedLine[] {
  const out = run.outputs?.[nodeId];
  const source = run.steps[nodeId]?.status === "waiting" ? out?.pending_items : (out?.items ?? out?.pending_items);
  if (!Array.isArray(source)) return [];
  return source.flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isChangedLine);
}

/** Whether a checkpoint's items come from a doc.write's changed lines (so an empty list is worth saying). */
export function changedLinesWired(run: Pick<WorkflowRunView, "graph">, nodeId: string): boolean {
  const writes = new Set(run.graph.nodes.filter((n) => n.type === "doc.write").map((n) => n.id));
  return run.graph.edges.some((e) => e.target === nodeId && e.targetHandle === "items" && e.sourceHandle === "lines" && writes.has(e.source));
}

/** "4 kept, 1 rejected, 1 skipped" for a recorded change with per-line results; "" otherwise. */
export function lineResultSummary(result: Pick<ChangeResult, "lines">): string {
  if (!result.lines?.length) return "";
  const n = (k: LineResult["result"]) => result.lines!.filter((l) => l.result === k).length;
  return [
    [n("accepted"), "kept"],
    [n("rejected"), "rejected"],
    [n("skipped"), "skipped"],
  ]
    .filter(([c]) => c)
    .map(([c, w]) => `${c} ${w}`)
    .join(", ");
}

// --- Classifier chip ---------------------------------------------------------------------------------------

/**
 * The chip's main action (phase6-spec.md §8.3): "Apply" merges the outline
 * into an untyped document; on a document that already has a type (the drift
 * case) it reads "Restructure?" and opens the restructure workflow instead.
 */
export function chipApplyAction(typeKey: string | null): { label: "Apply" | "Restructure?"; restructure: boolean } {
  return typeKey ? { label: "Restructure?", restructure: true } : { label: "Apply", restructure: false };
}

/** The Workflows tab's prefill for "Restructure…" to `targetType`. */
export function restructurePrefill(targetType: string): WorkflowsPrefill {
  return { workflowKey: RESTRUCTURE_KEY, targetType };
}
