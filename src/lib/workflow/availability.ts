// Which workflows a document can run (phase6-spec.md §2.6), and the checks
// before starting one: the built-ins for its type (generic ones first), then
// the team's own; the type's policy (NIH turns draft-all off unless the person
// acknowledges why; a team workflow that drafts sections falls under the same
// policy); and the run's params (restructure's target type and mode).
// A team workflow bound to a type (Phase 8: learned with it) is offered only on
// documents of that type, ahead of the general-report fallback; requirement
// sets resolve from the catalog first, then the team's inferred sets.
// Server-only.

import { getType } from "@/catalog";
import type { RequirementSet } from "@/catalog/requirements-schema";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import { parseBuiltInId, typePolicy, workflowsForType } from "@/catalog/workflows";
import type { WorkflowDefinition } from "@/catalog/workflow-schema";
import type { DocumentRecord } from "@/lib/documents/store";
import { BUILTIN_WORKFLOW_PREFIX, RunParams, type AvailableWorkflow, type OutcomeValue, type RequirementRef } from "./contract";
import { CHECKPOINT_NODE_TYPE, OUTPUT_NODE_TYPE, configFor, NODE_SPEC_INDEX } from "./registry";
import type { Auth } from "@/lib/ontology/governance";
import type { WorkflowRunRecord } from "./contract";
import { listTeamRequirementSets, resolveSet, setRef } from "@/lib/learn/store";
import { auditRun, createRun, getWorkflow, latestRuns, listWorkflows, type SavedWorkflow, type WorkflowInfo } from "./store";

/** The generic workflow a type's policy can turn off. */
export const DRAFT_ALL_KEY = "draft-all";
/** What the person acknowledges to run draft-all anyway (goes in params.acknowledge). */
export const DRAFT_ALL_ACK = "draft-all-policy";
/** The node that drafts empty sections; a team graph holding it falls under the draft-all policy. */
export const DRAFT_NODE_TYPE = "draft.section";
/** The generic workflow that maps a document onto another type's outline. */
export const RESTRUCTURE_KEY = "restructure";

/** The sets' references: catalog sets first, then the team's inferred sets (labelled); unknown keys are left out. */
const refs = (keys: string[], teamSets: RequirementSet[] = []): RequirementRef[] =>
  keys.flatMap((k) => {
    const set = resolveSet(k, teamSets);
    return set ? [setRef(set)] : [];
  });

function fromDefinition(def: WorkflowDefinition, typeDef: DocumentTypeDefinition | null, typeKey: string | null, teamSets: RequirementSet[] = []): Omit<AvailableWorkflow, "latestRun"> {
  const policy = typePolicy(typeKey, typeDef?.family);
  const off = def.key === DRAFT_ALL_KEY && policy.draftAll?.enabled === false ? policy.draftAll : null;
  const params = def.key === RESTRUCTURE_KEY ? (["targetType", "mode"] as const) : def.params;
  return {
    id: `${BUILTIN_WORKFLOW_PREFIX}${def.key}`,
    key: def.key,
    title: def.title,
    summary: def.summary,
    kind: def.kind,
    version: def.version,
    outcome: { label: def.outcome.label, values: def.outcome.values },
    checkpoint: def.checkpoint,
    params: [...params],
    enabled: !off,
    disabledReason: off ? off.reason : null,
    acknowledge: off ? { key: DRAFT_ALL_ACK, text: off.acknowledge } : null,
    requirementSets: refs(def.requirementSets, teamSets),
  };
}

type Gate = Pick<AvailableWorkflow, "enabled" | "disabledReason" | "acknowledge">;

const OPEN: Gate = { enabled: true, disabledReason: null, acknowledge: null };

/**
 * The draft-all policy for a team workflow, judged by what its graph does, not
 * its name: a copy of draft-all, or any graph with a draft.section node, is
 * turned off (with the same notice to acknowledge) wherever the type's policy
 * turns draft-all off.
 */
function teamGate(graph: SavedWorkflow["graph"], typeDef: DocumentTypeDefinition | null, typeKey: string | null): Gate {
  const off = typePolicy(typeKey, typeDef?.family).draftAll;
  if (off?.enabled !== false || !graph.nodes.some((n) => n.type === DRAFT_NODE_TYPE)) return OPEN;
  return { enabled: false, disabledReason: off.reason, acknowledge: { key: DRAFT_ALL_ACK, text: off.acknowledge } };
}

/** What a team workflow's graph declares: its outcome (label and values) and its checkpoint role. */
function graphFacts(saved: SavedWorkflow, teamSets: RequirementSet[]): Pick<AvailableWorkflow, "outcome" | "checkpoint" | "requirementSets"> {
  const out = saved.graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  const cp = saved.graph.nodes.find((n) => n.type === CHECKPOINT_NODE_TYPE);
  const outConfig = out ? (configFor(NODE_SPEC_INDEX[OUTPUT_NODE_TYPE], out.config) as { label: string; values: OutcomeValue[]; requirementSets: string[] }) : null;
  const cpConfig = cp ? (configFor(NODE_SPEC_INDEX[CHECKPOINT_NODE_TYPE], cp.config) as { role: string }) : null;
  return {
    outcome: { label: outConfig?.label ?? "Result", values: outConfig?.values ?? [] },
    checkpoint: cpConfig ? { role: cpConfig.role, required: true } : null,
    requirementSets: refs(outConfig?.requirementSets ?? [], teamSets),
  };
}

/** Is a team workflow offered on a document of this type? Unbound ones are offered everywhere; a bound one on its type (by key or alias). */
export function offeredFor(w: Pick<WorkflowInfo, "applies_to">, typeKey: string | null, typeDef: Pick<DocumentTypeDefinition, "key" | "aliases"> | null): boolean {
  if (!w.applies_to) return true;
  return w.applies_to === typeKey || w.applies_to === typeDef?.key || !!typeDef?.aliases.includes(w.applies_to);
}

/**
 * The workflows a document can run: the built-ins for its type (generic ones
 * first; type workflows only for a typed document), then the team's own, each
 * with its latest run on the document. A team workflow bound to the document's
 * type comes before the built-in type workflows when those are only the
 * general-report fallback (which stays listed after it).
 */
export async function availableWorkflows(teamId: string, doc: DocumentRecord, typeDef: DocumentTypeDefinition | null): Promise<AvailableWorkflow[]> {
  const [latest, own, teamSets] = await Promise.all([latestRuns(teamId, doc.id), listWorkflows(teamId), listTeamRequirementSets(teamId)]);
  const defs = workflowsForType(doc.type_key);
  const generic = defs.filter((d) => d.kind === "generic").map((d) => fromDefinition(d, typeDef, doc.type_key, teamSets));
  const typed = defs.filter((d) => d.kind !== "generic");
  const typedViews = typed.map((d) => fromDefinition(d, typeDef, doc.type_key, teamSets));
  const team = await Promise.all(
    own
      .filter((w) => offeredFor(w, doc.type_key, typeDef))
      .map(async (w): Promise<(Omit<AvailableWorkflow, "latestRun"> & { bound: boolean }) | null> => {
        const saved = await getWorkflow(teamId, w.id);
        if (!saved) return null;
        return {
          id: w.id,
          key: w.id,
          title: w.name,
          summary: "",
          kind: "team",
          version: saved.version,
          ...graphFacts(saved, teamSets),
          params: [],
          ...teamGate(saved.graph, typeDef, doc.type_key),
          bound: !!w.applies_to,
        };
      }),
  );
  const views = team.filter((x) => x !== null).map(({ bound, ...a }) => ({ a, bound }));
  const bound = views.filter((v) => v.bound).map((v) => v.a);
  const unbound = views.filter((v) => !v.bound).map((v) => v.a);
  const fallbackOnly = typed.length > 0 && typed.every((d) => d.fallback);
  const ordered = fallbackOnly ? [...generic, ...bound, ...typedViews, ...unbound] : [...generic, ...typedViews, ...bound, ...unbound];
  return ordered.map((a) => ({ ...a, latestRun: latest[a.id] ?? null }));
}

export type RunPlan =
  | { ok: true; workflow: SavedWorkflow; params: RunParams; acknowledged: string[] }
  | { ok: false; status: 400 | 404 | 409; error: string; acknowledge?: { key: string; text: string } };

/**
 * Check a start request against what the document is offered: the workflow
 * exists and applies to the document, the policy allows it (or the person
 * acknowledged it), and the declared params are valid (targetType an enabled
 * type; mode defaults to merge). Undeclared params are dropped.
 */
export async function planRun(teamId: string, doc: DocumentRecord, req: { workflowId: string; version?: number; params?: RunParams }): Promise<RunPlan> {
  const typeDef = (await getType(teamId, doc.type_key))?.definition ?? null;
  const offered = (await availableWorkflows(teamId, doc, typeDef)).find((a) => a.id === req.workflowId);
  if (!offered) {
    const known = parseBuiltInId(req.workflowId) === null ? await getWorkflow(teamId, req.workflowId) : null;
    return known || parseBuiltInId(req.workflowId) !== null
      ? { ok: false, status: 400, error: "That workflow doesn't apply to this document." }
      : { ok: false, status: 404, error: "Workflow not found." };
  }
  const workflow = await getWorkflow(teamId, req.workflowId, req.version);
  if (!workflow) return { ok: false, status: 404, error: req.version === undefined ? "Workflow not found." : `Version ${req.version} not found.` };

  // A team workflow is judged on the version being run: an older one may draft where the latest doesn't.
  const gate: Gate = offered.kind === "team" ? teamGate(workflow.graph, typeDef, doc.type_key) : offered;
  const given = req.params ?? {};
  const acknowledged = (given.acknowledge ?? []).filter((k) => gate.acknowledge?.key === k);
  if (!gate.enabled && !(gate.acknowledge && acknowledged.length)) {
    return { ok: false, status: 409, error: gate.disabledReason ?? "This workflow is turned off for this type.", ...(gate.acknowledge ? { acknowledge: gate.acknowledge } : {}) };
  }

  const params: RunParams = {};
  if (offered.params.includes("targetType")) {
    if (!given.targetType) return { ok: false, status: 400, error: "Choose a type to restructure to." };
    const target = await getType(teamId, given.targetType);
    if (!target?.enabled) return { ok: false, status: 400, error: "That type isn't available." };
    params.targetType = target.definition.key;
  }
  if (offered.params.includes("mode")) params.mode = given.mode ?? "merge";
  if (acknowledged.length) params.acknowledge = acknowledged;
  return { ok: true, workflow, params, acknowledged };
}

/** Create the run a plan allows (the route runs it in after()); an acknowledged policy notice is audited. */
export async function startPlannedRun(teamId: string, doc: DocumentRecord, plan: Extract<RunPlan, { ok: true }>, auth: Auth): Promise<WorkflowRunRecord> {
  const run = await createRun(teamId, doc.id, plan.workflow, plan.params, auth);
  if (plan.acknowledged.length) await auditRun(run, "workflow_policy_acknowledged", { documentId: doc.id, runId: run.id, acknowledge: plan.acknowledged }, undefined, auth.agent);
  return run;
}
