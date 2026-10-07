// The node library. Each node type declares its settings (validated with zod),
// its input and output ports (which may depend on its settings, e.g. one output
// per extracted field), and whether it can loop over lists. Shared by the canvas
// and the engine; the engine's implementations live in engine.ts.

import { z } from "zod";
import { ModelChoice } from "@/lib/llm/model-choice";
import { modelForTier } from "@/lib/llm/tasks";
import type { PortSpec } from "./types";

export type Category = "Sources" | "Flow" | "AI" | "Text & logic";
export const CATEGORIES: Category[] = ["Sources", "Flow", "AI", "Text & logic"];

export type NodeSpec<C = Record<string, unknown>> = {
  type: string;
  category: Category;
  label: string;
  description: string;
  config: z.ZodType<C>;
  defaults: () => C;
  inputs: (config: C) => PortSpec[];
  outputs: (config: C) => PortSpec[];
  loopable?: boolean;
  /** At most one per workflow. */
  single?: boolean;
};

/** Port and variable names: lowercase, starting with a letter. */
export const PortName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and _; start with a letter");

const model = (temperature = 0.3) => ({ provider: "anthropic" as const, model: modelForTier("mid"), temperature });

const empty = z.object({});

function spec<C extends Record<string, unknown>>(s: NodeSpec<C>): NodeSpec {
  return s as unknown as NodeSpec;
}

const nameList = z.array(PortName).max(10).refine((a) => new Set(a).size === a.length, "names must be unique");

/** The node that records a run's result; every workflow needs exactly one. */
export const OUTPUT_NODE_TYPE = "output.save";
/** The human checkpoint, which pauses a run until someone continues it. */
export const CHECKPOINT_NODE_TYPE = "flow.checkpoint";

export const NODE_SPECS: NodeSpec[] = [
  // --- Sources ---------------------------------------------------------------
  spec({
    type: "source.documents",
    category: "Sources",
    label: "Source documents",
    description: "The extracted text of the uploaded source documents, as citable passages. Optionally only those whose name contains some text.",
    config: z.object({ nameContains: z.string().max(80) }),
    defaults: () => ({ nameContains: "" }),
    inputs: () => [],
    outputs: () => [
      { name: "documents", label: "documents", type: "text", list: true },
      { name: "names", label: "names", type: "text", list: true },
      { name: "combined", label: "combined", type: "text" },
    ],
  }),

  // --- Flow --------------------------------------------------------------------
  spec({
    type: CHECKPOINT_NODE_TYPE,
    category: "Flow",
    label: "Human checkpoint",
    description: "Pauses the run until someone continues it. They can leave items out and add a note for later steps.",
    config: z.object({ instructions: z.string().max(4000) }),
    defaults: () => ({ instructions: "Review the items. Leave out any that should not continue, and add a note if later steps need context." }),
    inputs: () => [{ name: "items", label: "items", type: "any", multiple: true }],
    outputs: () => [
      { name: "items", label: "items", type: "any", list: true },
      { name: "note", label: "note", type: "text" },
    ],
  }),
  spec({
    type: OUTPUT_NODE_TYPE,
    category: "Flow",
    label: "Save output",
    description: "Saves the text it receives as the run's result. Several connections are joined in order.",
    config: empty,
    defaults: () => ({}),
    inputs: () => [{ name: "text", label: "text", type: "text", multiple: true }],
    outputs: () => [],
    single: true,
  }),

  // --- AI ----------------------------------------------------------------------
  spec({
    type: "ai.ask",
    category: "AI",
    label: "Ask AI",
    description: "Prompt a model. Reference inputs in the prompt as {{name}}.",
    config: ModelChoice.extend({ prompt: z.string().trim().min(1).max(20000), inputs: nameList }),
    defaults: () => ({ ...model(0.3), prompt: "Summarize the following:\n\n{{input}}", inputs: ["input"] }),
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
    defaults: () => ({ ...model(0), fields: [{ name: "key_points", description: "The main points, one per item", list: true }], context: "" }),
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
      ...model(0),
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
    defaults: () => ({ operator: "contains", value: "" }),
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
    defaults: () => ({ mode: "equals", routes: [{ name: "complete", match: "Complete" }, { name: "incomplete", match: "Incomplete" }] }),
    inputs: () => [
      { name: "value", label: "value", type: "any" },
      { name: "key", label: "key (optional)", type: "text", optional: true },
    ],
    outputs: (c) => [...c.routes.map((r) => ({ name: r.name, label: r.name, type: "any" as const })), { name: "other", label: "other", type: "any" as const }],
  }),
];

export const NODE_SPEC_INDEX: Record<string, NodeSpec> = Object.fromEntries(NODE_SPECS.map((s) => [s.type, s]));

/** A node's settings parsed against its type, or the defaults when they don't parse. */
export function configFor(spec: NodeSpec, config: unknown): Record<string, unknown> {
  const r = spec.config.safeParse(config);
  return (r.success ? r.data : spec.defaults()) as Record<string, unknown>;
}
