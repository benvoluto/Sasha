// The engine's own nodes: the generic AI and text/logic nodes kept from the
// organizer, the human checkpoint, and the outcome node every workflow ends in.
//
// CONTRACT (Phase 6): owned by the engine-core track. Port names and config
// shapes are shared with the workflow definitions and the canvas.

import { z } from "zod";
import { ModelChoice } from "@/lib/llm/model-choice";
import { CHECKPOINT_VERDICTS, OutcomeValue, SEVERITIES, STEP_STATUSES } from "../contract";
import { ConfigKey, defaultModel, nameList, optionalJson, PortName, spec, type NodeSpec } from "../node-spec";

/** The node that records a run's outcome; every workflow needs exactly one. */
export const OUTPUT_NODE_TYPE = "outcome.report";
/** The human checkpoint, which pauses a run until a person approves, edits or rejects. */
export const CHECKPOINT_NODE_TYPE = "checkpoint";
/** Node types renamed in Phase 6; saved graphs are read with the new names (store normalize). */
export const LEGACY_NODE_TYPES: Record<string, string> = {
  "flow.checkpoint": CHECKPOINT_NODE_TYPE,
  "clinical.checkpoint": CHECKPOINT_NODE_TYPE,
  "output.save": OUTPUT_NODE_TYPE,
  "source.documents": "sources.read",
};

/**
 * When an outcome rule applies. All the given parts must hold; `anyOf` holds
 * when any of its conditions does. Counts are over the outcome's inputs.
 */
export type OutcomeCondition = {
  anyOf?: OutcomeCondition[];
  findings?: { severity?: Array<(typeof SEVERITIES)[number]>; status?: string[]; kind?: string[]; min: number };
  disagreements?: { min: number; blocking?: boolean };
  computeFailed?: { min: number };
  score?: { item: string; stat: "median" | "min" | "max"; op: "<=" | ">=" | "<" | ">"; value: number };
  checkpoint?: { node?: string; verdict: (typeof CHECKPOINT_VERDICTS)[number] };
  steps?: { node: string; status: (typeof STEP_STATUSES)[number] };
};

export const OutcomeCondition: z.ZodType<OutcomeCondition> = z.lazy(() =>
  z.strictObject({
    anyOf: z.array(OutcomeCondition).min(1).max(8).optional(),
    findings: z
      .strictObject({
        severity: z.array(z.enum(SEVERITIES)).min(1).optional(),
        status: z.array(z.string().max(60)).min(1).optional(),
        kind: z.array(z.string().max(60)).min(1).optional(),
        min: z.number().int().min(1),
      })
      .optional(),
    disagreements: z.strictObject({ min: z.number().int().min(1), blocking: z.boolean().optional() }).optional(),
    computeFailed: z.strictObject({ min: z.number().int().min(1) }).optional(),
    score: z
      .strictObject({ item: ConfigKey, stat: z.enum(["median", "min", "max"]), op: z.enum(["<=", ">=", "<", ">"]), value: z.number() })
      .optional(),
    checkpoint: z.strictObject({ node: z.string().max(64).optional(), verdict: z.enum(CHECKPOINT_VERDICTS) }).optional(),
    steps: z.strictObject({ node: z.string().min(1).max(64), status: z.enum(STEP_STATUSES) }).optional(),
  }),
);

export const OutcomeRule = z.strictObject({ value: z.string().max(40), when: OutcomeCondition });
export type OutcomeRule = z.infer<typeof OutcomeRule>;

/**
 * A hard rule on the chosen value, applied after the decide step or the rules
 * picked it: when the value is one of `values` and `when` holds, the outcome
 * becomes `instead`, and the rationale says why. For rules a model must not be
 * able to talk its way past ("an unresolved blocking finding makes it approve
 * with changes or reject").
 */
export const OutcomeGuard = z.strictObject({ values: z.array(z.string().max(40)).min(1).max(8), when: OutcomeCondition, instead: z.string().max(40), reason: z.string().trim().min(1).max(300) });
export type OutcomeGuard = z.infer<typeof OutcomeGuard>;

export const OutcomeReportConfig = z
  .object({
    label: z.string().trim().min(1).max(120),
    /** The fixed values ("blocked" is added by the engine and must not be listed). */
    values: z.array(OutcomeValue).min(1).max(8),
    /** Tried in order when no `value` input arrives; the first that holds wins. */
    rules: z.array(OutcomeRule).max(12),
    /** The value when no rule holds. */
    fallback: z.string().max(40),
    /** Keep only the N most severe findings in the outcome (0: all). */
    topFindings: z.number().int().min(0).max(200),
    /** When set, topFindings caps only findings of these kinds (reviewer weaknesses); every other finding is kept. */
    topFindingsKinds: z.array(z.string().max(60)).max(12).default([]),
    /** Hard rules on the chosen value, in order (see OutcomeGuard). */
    guards: z.array(OutcomeGuard).max(8).default([]),
    notAssessed: z.array(z.string().max(300)).max(12),
    notes: z.array(z.string().max(500)).max(12),
    /** Requirement set keys shown with "Verify before relying". */
    requirementSets: z.array(z.string().max(80)).max(12),
  })
  .superRefine((c, ctx) => {
    const keys = new Set(c.values.map((v) => v.key));
    if (keys.size !== c.values.length) ctx.addIssue({ code: "custom", path: ["values"], message: "outcome values must be unique" });
    if (keys.has("blocked")) ctx.addIssue({ code: "custom", path: ["values"], message: "“blocked” is added automatically" });
    if (!keys.has(c.fallback)) ctx.addIssue({ code: "custom", path: ["fallback"], message: "the fallback must be one of the values" });
    c.rules.forEach((r, i) => {
      if (!keys.has(r.value)) ctx.addIssue({ code: "custom", path: ["rules", i, "value"], message: `“${r.value}” is not one of the values` });
    });
    c.guards.forEach((g, i) => {
      for (const v of [...g.values, g.instead]) if (!keys.has(v)) ctx.addIssue({ code: "custom", path: ["guards", i], message: `“${v}” is not one of the values` });
    });
  });
export type OutcomeReportConfig = z.infer<typeof OutcomeReportConfig>;

export const CheckpointConfig = z.object({
  instructions: z.string().max(4000),
  /** Who must decide, as the checkpoint shows it ("Supervisor", "Process owner and quality approver"). */
  role: z.string().trim().min(1).max(120),
  /** The items are the outcome: approving makes it final (no longer advisory) and records who and when. */
  signsOutcome: z.boolean(),
  /** The person may leave items out. */
  allowExclude: z.boolean(),
  /** What "Edit" may change: nothing, the outcome value, or the restructure mapping. */
  editable: z.enum(["none", "outcome", "rows"]),
  /** Fields the decision records (approver's version, effective date, next review date…). */
  recordFields: z.array(z.object({ key: ConfigKey, label: z.string().max(120), required: z.boolean() })).max(8),
  /**
   * People who must each sign (process owner, then quality approver). Empty:
   * one decision from the role. Otherwise the run waits until every signer has
   * approved or edited, or one rejects; one person can't sign for two.
   */
  signers: z.array(z.object({ key: ConfigKey, label: z.string().trim().min(1).max(120) })).max(4).default([]),
});
export type CheckpointConfig = z.infer<typeof CheckpointConfig>;

export const CORE_NODE_SPECS: NodeSpec[] = [
  // --- Flow --------------------------------------------------------------------
  spec({
    type: CHECKPOINT_NODE_TYPE,
    category: "Flow",
    label: "Human checkpoint",
    description: "Pauses the run until the named person approves, edits or rejects. Records who decided and when.",
    config: CheckpointConfig,
    defaults: () => ({
      instructions: "Review the items. Approve, edit or reject; add a note if later steps need context.",
      role: "Reviewer",
      signsOutcome: false,
      allowExclude: false,
      editable: "none" as const,
      recordFields: [],
      signers: [],
    }),
    inputs: () => [{ name: "items", label: "items", type: "any", multiple: true }],
    outputs: () => [
      { name: "items", label: "items", type: "any", list: true },
      { name: "decision", label: "decision", type: "json" },
      { name: "approved", label: "approved", type: "any" },
      { name: "rejected", label: "rejected", type: "any" },
    ],
  }),
  spec({
    type: OUTPUT_NODE_TYPE,
    category: "Flow",
    label: "Outcome",
    description: "Records the run's outcome: one of the workflow's fixed values (or “blocked: missing input”), with the findings, disagreements and tables behind it.",
    config: OutcomeReportConfig,
    defaults: () => ({
      label: "Result",
      values: [
        { key: "sound", label: "Sound" },
        { key: "gaps_found", label: "Gaps found" },
      ],
      rules: [{ value: "gaps_found", when: { findings: { severity: ["blocking", "major"] as Array<(typeof SEVERITIES)[number]>, min: 1 } } }],
      fallback: "sound",
      topFindings: 0,
      topFindingsKinds: [],
      guards: [],
      notAssessed: [],
      notes: [],
      requirementSets: [],
    }),
    inputs: () => [
      { name: "summary", label: "summary", type: "text", multiple: true, optional: true },
      { name: "value", label: "value", type: "text", optional: true },
      { name: "rationale", label: "rationale", type: "text", optional: true },
      optionalJson("blocked", "blocked", true),
      optionalJson("findings", "findings", true),
      optionalJson("agreed", "agreed", true),
      optionalJson("disagreements", "disagreements", true),
      optionalJson("scores", "scores", true),
      optionalJson("results", "results", true),
      optionalJson("tables", "tables", true),
    ],
    outputs: () => [{ name: "outcome", label: "outcome", type: "json" }],
    single: true,
  }),

  // --- AI ----------------------------------------------------------------------
  spec({
    type: "ai.ask",
    category: "AI",
    label: "Ask AI",
    description: "Prompt a model. Reference inputs in the prompt as {{name}}.",
    config: ModelChoice.extend({ prompt: z.string().trim().min(1).max(20000), inputs: nameList }),
    defaults: () => ({ ...defaultModel(0.3), prompt: "Summarize the following:\n\n{{input}}", inputs: ["input"] }),
    inputs: (c) => c.inputs.map((n) => ({ name: n, label: n, type: "text" as const })),
    outputs: () => [{ name: "response", label: "response", type: "text" }],
    loopable: true,
  }),
  spec({
    type: "ai.extract",
    category: "AI",
    label: "Extract data",
    description: "Pull named pieces of information out of text. Each field becomes an output.",
    config: ModelChoice.extend({
      fields: z
        .array(z.object({ name: PortName, description: z.string().max(500), list: z.boolean() }))
        .min(1)
        .max(12)
        .refine((a) => new Set(a.map((f) => f.name)).size === a.length, "field names must be unique"),
      context: z.string().max(4000),
    }),
    defaults: () => ({ ...defaultModel(0), fields: [{ name: "key_points", description: "The main points, one per item", list: true }], context: "" }),
    inputs: () => [{ name: "text", label: "text", type: "text" }],
    outputs: (c) => c.fields.map((f) => ({ name: f.name, label: f.name, type: "text" as const, list: f.list })),
    loopable: true,
  }),
  spec({
    type: "ai.categorize",
    category: "AI",
    label: "Categorizer",
    description: "Sort text into categories you describe. Pair with a Router to branch on the result.",
    config: ModelChoice.extend({
      categories: z
        .array(z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(1000) }))
        .min(2)
        .max(12),
    }),
    defaults: () => ({
      ...defaultModel(0),
      categories: [
        { name: "Complete", description: "The text covers its topic fully, with supporting evidence" },
        { name: "Incomplete", description: "The text leaves gaps: missing topics, evidence or data" },
      ],
    }),
    inputs: () => [{ name: "text", label: "text", type: "text" }],
    outputs: () => [
      { name: "category", label: "category", type: "text" },
      { name: "justification", label: "justification", type: "text" },
    ],
    loopable: true,
  }),

  // --- Text & logic ----------------------------------------------------------
  spec({
    type: "text.combine",
    category: "Text & logic",
    label: "Combine text",
    description: "Fill a template with inputs, referenced as {{name}}.",
    config: z.object({ template: z.string().max(20000), inputs: nameList }),
    defaults: () => ({ template: "{{input1}}\n\n{{input2}}", inputs: ["input1", "input2"] }),
    inputs: (c) => c.inputs.map((n) => ({ name: n, label: n, type: "text" as const })),
    outputs: () => [{ name: "text", label: "text", type: "text" }],
    loopable: true,
  }),
  spec({
    type: "logic.if",
    category: "Text & logic",
    label: "If / else",
    description: "Send the value down the true or false branch. Steps on the branch not taken are skipped.",
    config: z.object({ operator: z.enum(["contains", "equals", "not_empty", "is_empty"]), value: z.string().max(500) }),
    defaults: () => ({ operator: "contains" as const, value: "" }),
    inputs: () => [
      { name: "value", label: "value", type: "any" },
      { name: "test", label: "test (optional)", type: "text", optional: true },
    ],
    outputs: () => [
      { name: "true", label: "true", type: "any" },
      { name: "false", label: "false", type: "any" },
    ],
  }),
  spec({
    type: "logic.router",
    category: "Text & logic",
    label: "Router",
    description: "Send the value down the route whose match the key equals (or contains); otherwise down “other”.",
    config: z.object({
      mode: z.enum(["equals", "contains"]),
      routes: z
        .array(z.object({ name: PortName, match: z.string().min(1).max(200) }))
        .min(1)
        .max(8)
        .refine((a) => new Set(a.map((r) => r.name)).size === a.length && !a.some((r) => r.name === "other"), "route names must be unique and not “other”"),
    }),
    defaults: () => ({ mode: "equals" as const, routes: [{ name: "complete", match: "Complete" }, { name: "incomplete", match: "Incomplete" }] }),
    inputs: () => [
      { name: "value", label: "value", type: "any" },
      { name: "key", label: "key (optional)", type: "text", optional: true },
    ],
    outputs: (c) => [...c.routes.map((r) => ({ name: r.name, label: r.name, type: "any" as const })), { name: "other", label: "other", type: "any" as const }],
  }),
];
