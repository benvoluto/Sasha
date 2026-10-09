// The outcome node's evaluation (phase6-spec.md §2.4): one of the workflow's
// fixed values, or "blocked: missing input", or no value when a step failed,
// with the findings, agreement, scores, computed results and tables behind it.
// Pure: the handler in core-nodes.ts gathers the inputs and writes run.outcome.
//
// Order: blocked (a gate's missing inputs) → incomplete (any failed step) → the
// `value` input (a decide step) → the rules in order → the fallback; then the
// guards (hard rules) may replace a chosen value. A blocked or incomplete
// outcome carries no rationale: a decide step that ran anyway argued for a value
// the outcome does not have.

import { parseBuiltInId, requirementRef, requirementSet } from "@/catalog/workflows";
import {
  MAX_FINDINGS,
  OUTCOME_BLOCKED,
  OUTCOME_BLOCKED_LABEL,
  SEVERITIES,
  outcomeLabel,
  type AgreedItem,
  type CheckpointDecision,
  type ComputeResult,
  type Disagreement,
  type Finding,
  type GateReport,
  type Outcome,
  type OutcomeTable,
  type RequirementRef,
  type ScoreSummary,
  type StepState,
} from "./contract";
import type { OutcomeCondition, OutcomeReportConfig } from "./node-specs/core";

/** What the outcome node received, by input port (multiple inputs already flattened to lists). */
export type OutcomeInputs = {
  summary?: unknown;
  value?: unknown;
  rationale?: unknown;
  blocked?: unknown;
  findings?: unknown;
  agreed?: unknown;
  disagreements?: unknown;
  scores?: unknown;
  results?: unknown;
  tables?: unknown;
};

/** The run state the rules may read. */
export type OutcomeRunState = {
  workflowId: string;
  steps: Record<string, StepState>;
  checkpoints: Record<string, CheckpointDecision>;
  /** Display labels of nodes, by id (for the incomplete list). */
  labels: Record<string, string>;
  /** Resolves a requirement-set key the catalog lacks (a team's inferred set); omitted, those keys are left out. */
  resolveSet?: (key: string) => RequirementRef | null;
};

/** Thrown when a decide step returns a value that is not one of the outcome's values. */
export class OutcomeValueError extends Error {}

const list = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : Array.isArray(v) ? v.map(text).filter(Boolean).join("\n\n") : JSON.stringify(v));

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<string, number>;

/** Findings deduplicated by id (first wins), most severe first (stable within a severity). */
export function rankFindings(raw: unknown): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of list(raw)) {
    if (!isObject(f) || typeof f.id !== "string" || !(String(f.severity) in SEVERITY_RANK) || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f as unknown as Finding);
  }
  return out.map((f, i) => ({ f, i })).sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i).map(({ f }) => f);
}

/** Score summaries in order; a later summary for the same item replaces the earlier one in place (a rescore wins). */
export function mergeScores(raw: unknown): ScoreSummary[] {
  const out: ScoreSummary[] = [];
  for (const s of list(raw)) {
    if (!isObject(s) || typeof s.item !== "string") continue;
    const at = out.findIndex((o) => o.item === s.item);
    if (at >= 0) out[at] = s as unknown as ScoreSummary;
    else out.push(s as unknown as ScoreSummary);
  }
  return out;
}

const objects = <T>(raw: unknown): T[] => list(raw).filter(isObject) as T[];

/** What the rules count over. */
export type RuleFacts = {
  findings: Finding[];
  disagreements: Disagreement[];
  computed: ComputeResult[];
  scores: ScoreSummary[];
  checkpoints: Record<string, CheckpointDecision>;
  steps: Record<string, StepState>;
};

const compare = (a: number, op: "<=" | ">=" | "<" | ">", b: number) => (op === "<=" ? a <= b : op === ">=" ? a >= b : op === "<" ? a < b : a > b);

/** Does the condition hold? Every part given must hold; an empty condition holds. */
export function conditionHolds(c: OutcomeCondition, facts: RuleFacts): boolean {
  if (c.anyOf && !c.anyOf.some((sub) => conditionHolds(sub, facts))) return false;
  if (c.findings) {
    const { severity, status, kind, min } = c.findings;
    const n = facts.findings.filter((f) => (!severity || severity.includes(f.severity)) && (!status || (f.status !== null && status.includes(f.status))) && (!kind || kind.includes(f.kind))).length;
    if (n < min) return false;
  }
  if (c.disagreements) {
    const n = facts.disagreements.filter((d) => !c.disagreements!.blocking || d.blocking).length;
    if (n < c.disagreements.min) return false;
  }
  if (c.computeFailed && facts.computed.filter((r) => r.ok === false).length < c.computeFailed.min) return false;
  if (c.score) {
    const s = facts.scores.find((x) => x.item === c.score!.item);
    const v = s ? Number(s[c.score.stat]) : NaN;
    if (!Number.isFinite(v) || !compare(v, c.score.op, c.score.value)) return false;
  }
  if (c.checkpoint) {
    const { node, verdict } = c.checkpoint;
    const decisions = node ? [facts.checkpoints[node]].filter(Boolean) : Object.values(facts.checkpoints);
    if (!decisions.some((d) => d.verdict === verdict)) return false;
  }
  if (c.steps && facts.steps[c.steps.node]?.status !== c.steps.status) return false;
  return true;
}

/** The requirement sets an outcome cites: the catalog's, then `fallback` (team sets); unknown keys are left out. */
export function resolveRequirementSets(keys: string[], fallback?: (key: string) => RequirementRef | null): RequirementRef[] {
  return keys.flatMap((k) => {
    const set = requirementSet(k);
    const ref = set ? requirementRef(set) : (fallback?.(k) ?? null);
    return ref ? [ref] : [];
  });
}

/** The workflow key an outcome records: the built-in key, or the team workflow id. */
export const workflowKeyOf = (workflowId: string) => parseBuiltInId(workflowId) ?? workflowId;

/** Evaluate the outcome. Throws OutcomeValueError for a decide value outside the outcome's values. */
export function evaluateOutcome(config: OutcomeReportConfig, inputs: OutcomeInputs, run: OutcomeRunState): Outcome {
  const findings = rankFindings(inputs.findings).slice(0, MAX_FINDINGS);
  const agreed = objects<AgreedItem>(inputs.agreed);
  const disagreements = objects<Disagreement>(inputs.disagreements);
  const scores = mergeScores(inputs.scores);
  const computed = objects<ComputeResult>(inputs.results);
  const tables = objects<OutcomeTable>(inputs.tables);
  const values = [...config.values, { key: OUTCOME_BLOCKED, label: OUTCOME_BLOCKED_LABEL }];
  const keys = new Set(config.values.map((v) => v.key));

  const missing = [
    ...new Set(
      objects<GateReport>(inputs.blocked)
        .flatMap((r) => (Array.isArray(r.missing) ? r.missing : []))
        .map((m) => String(m?.label ?? m?.key ?? ""))
        .filter(Boolean),
    ),
  ];
  const incomplete = Object.entries(run.steps)
    .filter(([, s]) => s.status === "failed")
    .map(([id]) => run.labels[id] ?? id);

  const facts: RuleFacts = { findings, disagreements, computed, scores, checkpoints: run.checkpoints, steps: run.steps };
  let value: string | null;
  let rationale = text(inputs.rationale).trim() || text(inputs.summary).trim();
  if (missing.length) value = OUTCOME_BLOCKED;
  else if (incomplete.length) value = null;
  else {
    const given = text(inputs.value).trim();
    if (given) {
      if (!keys.has(given)) throw new OutcomeValueError("the decision step returned an unknown value");
      value = given;
    } else {
      value = config.rules.find((r) => conditionHolds(r.when, facts))?.value ?? config.fallback;
    }
    for (const g of config.guards ?? []) {
      if (!g.values.includes(value) || !keys.has(g.instead) || !conditionHolds(g.when, facts)) continue;
      const note = `Changed from “${outcomeLabel(values, value)}” to “${outcomeLabel(values, g.instead)}”: ${g.reason}`;
      rationale = rationale ? `${note}\n\n${rationale}` : note;
      value = g.instead;
    }
  }
  if (value === OUTCOME_BLOCKED || value === null) rationale = "";

  const kinds = new Set(config.topFindingsKinds ?? []);
  let capped = 0;
  const shown =
    config.topFindings <= 0 ? findings : kinds.size ? findings.filter((f) => !kinds.has(f.kind) || capped++ < config.topFindings) : findings.slice(0, config.topFindings);

  return {
    workflowKey: workflowKeyOf(run.workflowId),
    label: config.label,
    value,
    valueLabel: outcomeLabel(values, value),
    values,
    rationale,
    advisory: true,
    missing: value === OUTCOME_BLOCKED ? missing : [],
    incomplete: value === null ? incomplete : [],
    findings: shown,
    agreed,
    disagreements,
    scores,
    computed,
    tables,
    notAssessed: config.notAssessed,
    notes: config.notes,
    requirementSets: resolveRequirementSets(config.requirementSets, run.resolveSet),
    verdict: null,
    signedBy: null,
    signedAt: null,
    signedRole: null,
    originalValue: null,
    record: {},
  };
}

/**
 * Stamp a signing checkpoint's decision on the outcome. Approve or edit makes
 * it final (an edited value keeps the original); reject records who rejected
 * it and leaves it advisory.
 */
export function signOutcome(outcome: Outcome, d: CheckpointDecision): Outcome {
  if (d.verdict === "reject") return { ...outcome, verdict: "reject", signedBy: d.by, signedAt: d.at };
  const next: Outcome = { ...outcome, advisory: false, verdict: d.verdict, signedBy: d.by, signedAt: d.at, signedRole: d.role, record: { ...(d.edits?.record ?? {}) } };
  const edited = d.verdict === "edit" ? d.edits?.outcomeValue : undefined;
  if (edited && edited !== outcome.value) {
    next.originalValue = outcome.value;
    next.value = edited;
    next.valueLabel = outcomeLabel(outcome.values, edited);
  }
  return next;
}
