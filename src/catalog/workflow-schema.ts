// Workflow definitions as data (PLAN §6.7, docs/workflows-by-document-type.md).
// One JSON file per workflow in src/catalog/workflows/, validated here and
// bundled by `npm run catalog:build` into workflows.bundle.json. A definition
// lists its steps (node type, settings, and which outputs feed which inputs);
// src/lib/workflow/compile.ts turns it into the graph the engine runs and the
// canvas shows. Adding a type's workflow is a new file, not code.
//
// src/catalog/workflow-policies.json holds per-type policy (sensitive types,
// public web domains, draft-all off) keyed by type key.
//
// Client-safe: zod and plain types only.
//
// CONTRACT (Phase 6): owned by the workflow-defs track.

import { z } from "zod";
// Relative (not @/): scripts/catalog/catalog-build.ts runs under vite-node without the alias.
import { OutcomeValue } from "../lib/workflow/contract";
import { TypeKey } from "./schema";

/** Workflow keys: kebab-case, e.g. "source-coverage", "type-fie". */
export const WORKFLOW_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WorkflowKey = z.string().min(2).max(80).regex(WORKFLOW_KEY_RE, "lowercase kebab-case");

const StepId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** "<step id>.<output port>". */
export const PortRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}\.[a-z][a-z0-9_]{0,39}$/, "<step>.<port>");

export const WorkflowStep = z.strictObject({
  id: StepId,
  /** A node type from src/lib/workflow/registry.ts. */
  node: z.string().min(1).max(60),
  label: z.string().trim().min(1).max(80).optional(),
  /** Settings, merged over the node type's defaults (top-level keys). */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Input port → the output(s) that feed it, in order. A list only for inputs that accept several. */
  in: z.record(z.string(), z.union([PortRef, z.array(PortRef).min(1).max(30)])).default({}),
  loop: z.boolean().default(false),
});
export type WorkflowStep = z.output<typeof WorkflowStep>;

export const WorkflowDefinitionShape = z.strictObject({
  key: WorkflowKey,
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1000),
  /** generic: offered for every type (and freeform documents); type: for the types in appliesTo. */
  kind: z.enum(["generic", "type"]),
  appliesTo: z.array(TypeKey).max(20).default([]),
  /** The type workflow for any type without one of its own (general report). At most one definition sets it. */
  fallback: z.boolean().default(false),
  /** The fixed outcome values; "blocked: missing input" is always added. Copied into the outcome step at compile. */
  outcome: z.strictObject({ label: z.string().trim().min(1).max(120), values: z.array(OutcomeValue).min(1).max(8) }),
  /** Where a person owns the decision; null when the author accepts or dismisses each finding. Copied into the checkpoint step's role. */
  checkpoint: z.strictObject({ role: z.string().trim().min(1).max(120), required: z.boolean() }).nullable(),
  /** Per-run inputs the person gives when starting it. */
  params: z.array(z.enum(["targetType", "mode"])).max(2).default([]),
  /** Requirement set keys the workflow reads (shown with "Verify before relying"). */
  requirementSets: z.array(z.string().max(80)).max(12).default([]),
  /** What the workflow does not assess (shown with the outcome). */
  notAssessed: z.array(z.string().max(300)).max(12).default([]),
  notes: z.array(z.string().max(500)).max(12).default([]),
  /** Where the workflow's logic comes from and when it was last checked against it. */
  provenance: z.strictObject({ source: z.string().trim().min(1).max(300), checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD") }),
  steps: z.array(WorkflowStep).min(1).max(60),
});

export const WorkflowDefinition = WorkflowDefinitionShape.superRefine((d, ctx) => {
  const ids = new Set<string>();
  d.steps.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `duplicate step id "${s.id}"` });
    ids.add(s.id);
  });
  d.steps.forEach((s, i) => {
    for (const [port, refs] of Object.entries(s.in)) {
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        const from = ref.slice(0, ref.indexOf("."));
        if (!ids.has(from)) ctx.addIssue({ code: "custom", path: ["steps", i, "in", port], message: `unknown step "${from}"` });
      }
    }
  });
  const outcomes = d.steps.filter((s) => s.node === "outcome.report").length;
  if (outcomes !== 1) ctx.addIssue({ code: "custom", path: ["steps"], message: "exactly one outcome.report step is required" });
  const checkpoints = d.steps.filter((s) => s.node === "checkpoint").length;
  if (d.checkpoint?.required && checkpoints === 0) ctx.addIssue({ code: "custom", path: ["checkpoint"], message: "a required checkpoint needs a checkpoint step" });
  if (d.kind === "type" && !d.appliesTo.length && !d.fallback) ctx.addIssue({ code: "custom", path: ["appliesTo"], message: "a type workflow names its types (or is the fallback)" });
  if (new Set(d.outcome.values.map((v) => v.key)).size !== d.outcome.values.length) ctx.addIssue({ code: "custom", path: ["outcome", "values"], message: "outcome values must be unique" });
  if (d.outcome.values.some((v) => v.key === "blocked")) ctx.addIssue({ code: "custom", path: ["outcome", "values"], message: "“blocked” is added automatically" });
});
export type WorkflowDefinition = z.output<typeof WorkflowDefinition>;
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinition>;

export const TypeWorkflowPolicy = z.strictObject({
  /**
   * Records about people (student records under FERPA, clinical notes): web
   * search sends no document text and searches only `webDomains`. Types in the
   * clinical family are sensitive unless their policy says otherwise.
   */
  sensitive: z.boolean().default(false),
  /** Public domains web search may use (regulations, test manuals, agency sites). Required for a sensitive type. */
  webDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "a hostname")).max(30).default([]),
  /** Draft all empty sections: off by default for this type, with the reason shown and an acknowledgement to run it anyway. */
  draftAll: z.strictObject({ enabled: z.boolean(), reason: z.string().max(500), acknowledge: z.string().max(500) }).optional(),
});
export type TypeWorkflowPolicy = z.output<typeof TypeWorkflowPolicy>;

export const WorkflowPolicies = z.record(TypeKey, TypeWorkflowPolicy);
export type WorkflowPolicies = z.output<typeof WorkflowPolicies>;

export function parseWorkflowDefinition(input: unknown): { ok: true; definition: WorkflowDefinition } | { ok: false; errors: string[] } {
  const r = WorkflowDefinition.safeParse(input);
  if (r.success) return { ok: true, definition: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
