// The built-in workflows, requirement sets and per-type workflow policies that
// ship with the app: workflows.bundle.json and requirements.bundle.json (built
// by `npm run catalog:build` from src/catalog/workflows/ and
// src/catalog/requirements/) and workflow-policies.json. Client-safe (no
// database). Team workflows made on the canvas live in the workflow table
// (src/lib/workflow/store.ts).
//
// CONTRACT (Phase 6): the exported names and signatures are shared by every
// track. The workflow-defs track owns the implementation.

import policiesJson from "./workflow-policies.json";
import requirementsBundle from "./requirements.bundle.json";
import workflowsBundle from "./workflows.bundle.json";
import { BUILTIN_WORKFLOW_PREFIX, type RequirementRef } from "@/lib/workflow/contract";
import { RequirementSet, parseRequirementRef, type RequirementItem } from "./requirements-schema";
import type { Family } from "./schema";
import { TypeWorkflowPolicy, WorkflowDefinition, WorkflowPolicies } from "./workflow-schema";

function parseAll<T>(raw: unknown[], schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, what: string): T[] {
  const out: T[] = [];
  for (const r of raw) {
    const p = schema.safeParse(r);
    if (p.success) out.push(p.data);
    else console.error(`[catalog] invalid bundled ${what} skipped`, (r as { key?: unknown })?.key, p.error.issues[0]);
  }
  return out;
}

let workflows: WorkflowDefinition[] | null = null;
let requirements: RequirementSet[] | null = null;
let policies: WorkflowPolicies | null = null;

/** Every built-in workflow definition, sorted by key. */
export function builtInWorkflows(): WorkflowDefinition[] {
  workflows ??= parseAll(workflowsBundle as unknown[], WorkflowDefinition, "workflow").sort((a, b) => a.key.localeCompare(b.key));
  return workflows;
}

export function builtInWorkflow(key: string): WorkflowDefinition | null {
  return builtInWorkflows().find((w) => w.key === key) ?? null;
}

/** "builtin:<key>" for a built-in workflow's id in runs and routes. */
export const builtInId = (key: string) => `${BUILTIN_WORKFLOW_PREFIX}${key}`;
/** The key in a "builtin:<key>" id, or null for a team workflow id. */
export function parseBuiltInId(id: string): string | null {
  return id.startsWith(BUILTIN_WORKFLOW_PREFIX) ? id.slice(BUILTIN_WORKFLOW_PREFIX.length) : null;
}

/**
 * The built-in workflows a document of this type is offered: every generic
 * workflow, then the type's own workflows, or the fallback type workflow
 * (general report) when it has none. A freeform document (null type) gets the
 * generic workflows only.
 */
export function workflowsForType(typeKey: string | null): WorkflowDefinition[] {
  const all = builtInWorkflows();
  const generic = all.filter((w) => w.kind === "generic");
  if (!typeKey) return generic;
  const own = all.filter((w) => w.kind === "type" && w.appliesTo.includes(typeKey));
  const typed = own.length ? own : all.filter((w) => w.kind === "type" && w.fallback);
  return [...generic, ...typed];
}

/** Every requirement set, sorted by key. */
export function requirementSets(): RequirementSet[] {
  requirements ??= parseAll(requirementsBundle as unknown[], RequirementSet, "requirement set").sort((a, b) => a.key.localeCompare(b.key));
  return requirements;
}

export function requirementSet(key: string): RequirementSet | null {
  return requirementSets().find((s) => s.key === key) ?? null;
}

/** The sets that apply to a type. */
export function requirementSetsForType(typeKey: string | null): RequirementSet[] {
  return typeKey ? requirementSets().filter((s) => s.appliesTo.includes(typeKey)) : [];
}

/** A requirement item by "<set>#<item>", with its set; null when either is unknown. */
export function requirementItem(ref: string): { set: RequirementSet; item: RequirementItem } | null {
  const p = parseRequirementRef(ref);
  const set = p ? requirementSet(p.set) : null;
  const item = set?.items.find((i) => i.key === p!.item);
  return set && item ? { set, item } : null;
}

/** How a requirement set is cited beside an outcome. */
export function requirementRef(set: RequirementSet): RequirementRef {
  return { key: set.key, title: set.title, effective: set.effective, checked: set.checked, url: set.provenance.url, verifyNote: set.verifyNote };
}

/**
 * A type's workflow policy. Types without an entry get the defaults, except
 * that a clinical-family type is treated as sensitive (and, with no public
 * domains named, web search is refused for it).
 */
export function typePolicy(typeKey: string | null, family?: Family | null): TypeWorkflowPolicy {
  if (!policies) {
    const r = WorkflowPolicies.safeParse(policiesJson);
    if (!r.success) console.error("[catalog] invalid workflow-policies.json ignored", r.error.issues[0]);
    policies = r.success ? r.data : {};
  }
  const own = typeKey ? policies[typeKey] : undefined;
  if (own) return own;
  return TypeWorkflowPolicy.parse({ sensitive: family === "clinical" });
}
