// Validation and normalization of a learned draft (PLAN §6.11). The model's
// three drafts (type, workflow, inferred requirement sets) are normalized
// first (keys made unique, provenance "Learned from N example(s)", the
// workflow bound to the type, inferred-set keys prefixed and remapped in the
// workflow), then validated exactly as the catalog build validates shipped
// files:
// - type: parseDefinition;
// - requirement sets: parseRequirementSet, inferred with no URL;
// - workflow: parseWorkflowDefinition, the structural rules the catalog tests
//   enforce on built-ins (src/catalog/workflows.test.ts: allowed nodes, gate
//   wiring, decide values = outcome values, distinct reviewer briefs, the
//   checkpoint step, section keys of the type, resolvable requirement refs),
//   then compileWorkflow → validateGraph.
//
// Pure and client-safe; the extraction, the save route and the review screen
// (after an edit) all run it.

import { slugify, typeKeyFromTitle, uniqueKey } from "@/catalog/from-outline";
import { parseRequirementSet, type RequirementSet } from "@/catalog/requirements-schema";
import { parseDefinition, type DocumentTypeDefinition, type Family } from "@/catalog/schema";
import { builtInWorkflows, requirementItem, requirementSet } from "@/catalog/workflows";
import { parseWorkflowDefinition, type WorkflowDefinition } from "@/catalog/workflow-schema";
import { compileWorkflow } from "@/lib/workflow/compile";
import { CHECKPOINT_NODE_TYPE, OUTPUT_NODE_TYPE } from "@/lib/workflow/registry";
import { validateGraph } from "@/lib/workflow/validate";
import {
  LEARN_MAX_REQUIREMENT_SETS,
  TEAM_REQUIREMENT_SET_PREFIX,
  type ExampleDifference,
  type LearnConfidence,
  type LearnDraft,
  type LearnedPart,
  type LearnExampleView,
} from "./contract";
import { isLearnNode } from "./node-catalog";
import { sectionKeyErrors } from "./section-keys";

export type Validation = LearnDraft["validation"];
export const emptyValidation = (): Validation => ({ type: [], workflow: [], graph: [], requirementSets: [] });

/** "Learned from 1 example" / "Learned from 3 examples". */
export const learnedSource = (n: number) => `Learned from ${n} example${n === 1 ? "" : "s"}`;

/** A JSON string from the model, or the error to send back in the repair round. */
export function parseJsonText(text: string, what: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: `${what}: not valid JSON (${e instanceof Error ? e.message : "parse error"})` };
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// --- Normalization -----------------------------------------------------------------

export type NormalizeContext = {
  /** Every type key and alias the team already uses (catalog, legacy aliases, team types). */
  takenTypeKeys: ReadonlySet<string>;
  /** Requirement set keys in use: the catalog's and the team's inferred sets. */
  takenSetKeys: ReadonlySet<string>;
  exampleCount: number;
  today: string;
  /** The author's title and family win over the model's. */
  title?: string;
  family?: Family;
};

/**
 * The type with the fields the server owns: a key from the title unique for
 * the team, version 1, no aliases, Team provenance. With 2+ examples a section
 * the parts say not every example has becomes optional (keep what they share).
 */
export function normalizeType(raw: unknown, ctx: NormalizeContext, parts: LearnedPart[] = []): Record<string, unknown> {
  const t = obj(raw);
  const title = ctx.title ?? (typeof t.title === "string" && t.title.trim() ? t.title.trim() : "Learned type");
  const notShared = new Set(ctx.exampleCount > 1 ? parts.filter((p) => !p.shared && /^type\.sections\.[^.]+$/.test(p.path)).map((p) => p.path.split(".")[2]) : []);
  const sections = Array.isArray(t.sections) ? t.sections.map((s) => (notShared.has(String(obj(s).key)) ? { ...obj(s), required: false } : s)) : t.sections;
  return {
    ...t,
    key: uniqueKey(typeKeyFromTitle(title), ctx.takenTypeKeys),
    version: 1,
    title,
    ...(ctx.family ? { family: ctx.family } : {}),
    aliases: [],
    sections,
    provenance: { source: learnedSource(ctx.exampleCount), url: "", license: "Team", retrieved: ctx.today },
  };
}

/** A team set key: "team-<slug>", unique against `taken`. */
export function teamSetKey(raw: string, typeKey: string, taken: ReadonlySet<string>): string {
  let base = slugify(raw.replace(new RegExp(`^${TEAM_REQUIREMENT_SET_PREFIX}`), ""), 60) || typeKey;
  if (base.length < 2) base = typeKey;
  return uniqueKey(`${TEAM_REQUIREMENT_SET_PREFIX}${base}`.slice(0, 74), taken);
}

/** Who an inferred set is from: always the team's examples, never an agency the model or the client names. */
export const LEARNED_AUTHORITY = "Inferred from the team's examples";

/**
 * An inferred set's server-owned fields, the same at extraction and at save
 * (a client may have edited anything): version 1, the team's examples as the
 * authority, bound to the type, no effective date, checked today, current,
 * inferred, Team provenance with no URL.
 */
export function learnedSetFields(typeKey: string, exampleCount: number, today: string) {
  return {
    version: 1,
    authority: LEARNED_AUTHORITY,
    jurisdiction: "Team",
    appliesTo: [typeKey],
    effective: "" as const,
    checked: today,
    supersedes: null,
    status: "current" as const,
    inferred: true,
    provenance: { source: learnedSource(exampleCount), url: "", license: "Team" },
  };
}

/**
 * Inferred sets with the server-owned fields (team key, the type, inferred,
 * no URL, dated today), at most LEARN_MAX_REQUIREMENT_SETS. `keyMap` maps the
 * model's keys to the new ones, for the workflow.
 */
export function normalizeRequirementSets(raw: unknown, typeKey: string, ctx: NormalizeContext): { sets: Record<string, unknown>[]; keyMap: Map<string, string> } {
  const list = (Array.isArray(raw) ? raw : []).slice(0, LEARN_MAX_REQUIREMENT_SETS);
  const taken = new Set(ctx.takenSetKeys);
  const keyMap = new Map<string, string>();
  const sets = list.map((s) => {
    const o = obj(s);
    const old = typeof o.key === "string" ? o.key : "";
    const key = teamSetKey(old || typeKey, typeKey, taken);
    taken.add(key);
    if (old) keyMap.set(old, key);
    return { ...o, key, ...learnedSetFields(typeKey, ctx.exampleCount, ctx.today) };
  });
  return { sets, keyMap };
}

/** Replace requirement set keys (and "<set>#<item>" refs) anywhere in a value. */
export function remapSetKeys<T>(value: T, keyMap: ReadonlyMap<string, string>): T {
  if (!keyMap.size) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (keyMap.has(v)) return keyMap.get(v);
      const hash = v.indexOf("#");
      if (hash > 0 && keyMap.has(v.slice(0, hash))) return `${keyMap.get(v.slice(0, hash))}${v.slice(hash)}`;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * Pure: the outcome wired to a lone gate. The model often leaves the gate's
 * `blocked` output off the outcome (or gives the outcome an `after`), which
 * cost a whole repair round; with one gate and one outcome there is only one
 * right wiring, so it is set here.
 */
export function wireGateToOutcome(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  const gates = steps.filter((s) => obj(s).node === "step.gate");
  const outs = steps.filter((s) => obj(s).node === OUTPUT_NODE_TYPE);
  if (gates.length !== 1 || outs.length !== 1 || typeof obj(gates[0]).id !== "string") return steps;
  const gateId = String(obj(gates[0]).id);
  return steps.map((s) => {
    if (s !== outs[0]) return s;
    const { after: _after, ...rest } = obj(obj(s).in);
    void _after;
    return { ...obj(s), in: { ...rest, blocked: `${gateId}.blocked` } };
  });
}

/** The workflow bound to the type: kind "type", appliesTo [type key], never the fallback, provenance from the examples, set keys remapped, a lone gate wired to the outcome. */
export function normalizeWorkflow(raw: unknown, typeKey: string, keyMap: ReadonlyMap<string, string>, ctx: NormalizeContext): Record<string, unknown> {
  const w = obj(raw);
  const steps = wireGateToOutcome(Array.isArray(w.steps) ? w.steps.map((s) => ({ ...obj(s), config: remapSetKeys(obj(s).config ?? {}, keyMap) })) : w.steps);
  return {
    ...w,
    key: `learned-${typeKey}`.slice(0, 80).replace(/-+$/, ""),
    version: 1,
    kind: "type",
    appliesTo: [typeKey],
    fallback: false,
    params: [],
    requirementSets: remapSetKeys(Array.isArray(w.requirementSets) ? w.requirementSets : [], keyMap),
    provenance: { source: learnedSource(ctx.exampleCount), checked: ctx.today },
    steps,
  };
}

// --- Workflow rules ------------------------------------------------------------------

const refsOf = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const briefSet = (reviewers: unknown) =>
  (Array.isArray(reviewers) ? reviewers : [])
    .map((r) => String(obj(r).brief ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .sort()
    .join("\u0000");

let builtInBriefs: Set<string> | null = null;
function catalogBriefSets(): Set<string> {
  if (!builtInBriefs) {
    builtInBriefs = new Set<string>();
    for (const w of builtInWorkflows()) {
      for (const n of compileWorkflow(w).nodes) if (n.type === "step.review") builtInBriefs.add(briefSet(n.config.reviewers));
    }
  }
  return builtInBriefs;
}

/**
 * The structural rules src/catalog/workflows.test.ts enforces on every
 * built-in, for a learned workflow and its type. `inferredSets` are the
 * draft's own set keys (readable only through requirements.read).
 */
export function workflowRules(def: WorkflowDefinition, type: Pick<DocumentTypeDefinition, "key" | "sections"> | null, inferredSets: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const graph = compileWorkflow(def);
  const config = new Map(graph.nodes.map((n) => [n.id, n.config]));
  for (const s of def.steps) if (!isLearnNode(s.node)) errors.push(`steps.${s.id}: node "${s.node}" is not allowed in a learned workflow`);
  if (def.kind !== "type" || (type && (def.appliesTo.length !== 1 || def.appliesTo[0] !== type.key))) errors.push("appliesTo: a learned workflow applies to its own type only");

  const out = def.steps.find((s) => s.node === OUTPUT_NODE_TYPE);
  const gate = def.steps.find((s) => s.node === "step.gate");
  if (gate && out) {
    if (out.in.blocked !== `${gate.id}.blocked`) errors.push(`steps.${out.id}.in.blocked: wire the gate's blocked output ("${gate.id}.blocked") into the outcome`);
    if (!def.steps.some((s) => refsOf(s.in.after).includes(`${gate.id}.pass`))) errors.push(`steps: no step runs after the gate passes (add "after": "${gate.id}.pass" to the steps it guards)`);
    if (out.in.after !== undefined) errors.push(`steps.${out.id}.in.after: the outcome must run when blocked, so it takes no "after"`);
  }
  const values = def.outcome.values.map((v) => v.key).sort();
  for (const s of def.steps.filter((x) => x.node === "step.decide")) {
    if (gate && !refsOf(s.in.after).includes(`${gate.id}.pass`)) errors.push(`steps.${s.id}.in.after: a decide step runs only after the gate passes ("${gate.id}.pass")`);
    const own = [...((config.get(s.id)?.values as string[] | undefined) ?? [])].sort();
    if (own.join(",") !== values.join(",")) errors.push(`steps.${s.id}.config.values: must equal the outcome values (${values.join(", ")})`);
  }
  const catalogBriefs = catalogBriefSets();
  for (const s of def.steps.filter((x) => x.node === "step.review")) {
    const reviewers = (config.get(s.id)?.reviewers as Array<{ brief?: string }> | undefined) ?? [];
    const briefs = reviewers.map((r) => String(r.brief ?? "").trim().toLowerCase());
    if (briefs.length < 2 || briefs.length > 3) errors.push(`steps.${s.id}.config.reviewers: give two or three reviewers`);
    if (new Set(briefs).size !== briefs.length) errors.push(`steps.${s.id}.config.reviewers: each reviewer needs a different brief`);
    if (briefs.some((b) => b.length < 20)) errors.push(`steps.${s.id}.config.reviewers: each brief needs at least 20 characters`);
    if (catalogBriefs.has(briefSet(reviewers))) errors.push(`steps.${s.id}.config.reviewers: write briefs for this type rather than reusing a catalog workflow's`);
  }
  const checkpoints = def.steps.filter((s) => s.node === CHECKPOINT_NODE_TYPE).length;
  if (def.checkpoint && checkpoints !== 1) errors.push("steps: a workflow with a checkpoint has exactly one checkpoint step");
  if (!def.checkpoint && checkpoints) errors.push("checkpoint: name the checkpoint's role, or remove the checkpoint step");

  if (type) errors.push(...sectionKeyErrors(def.steps, type.sections));

  const known = (k: string) => !!requirementSet(k) || inferredSets.has(k);
  for (const k of def.requirementSets) if (!known(k)) errors.push(`requirementSets: unknown requirement set "${k}"`);
  for (const s of def.steps) {
    const c = obj(config.get(s.id));
    if (s.node === "requirements.read") {
      for (const k of (c.sets as string[] | undefined) ?? []) if (!known(k)) errors.push(`steps.${s.id}.config.sets: unknown requirement set "${k}"`);
      for (const ref of (c.items as string[] | undefined) ?? []) {
        const set = ref.split("#")[0];
        if (!requirementItem(ref) && !inferredSets.has(set)) errors.push(`steps.${s.id}.config.items: unknown requirement "${ref}"`);
      }
    }
    if (s.node === "step.compute") {
      for (const check of (c.checks as Array<Record<string, unknown>> | undefined) ?? []) {
        const set = typeof check.requirementSet === "string" ? check.requirementSet : null;
        const byKind = obj(obj(check.byKind).requirements);
        const refs = [check.requirement, ...Object.values(byKind)].filter((r): r is string => typeof r === "string");
        for (const ref of refs) if (!requirementItem(ref)) errors.push(`steps.${s.id}.config.checks.${String(check.key)}: "${ref}" must be a catalog requirement (inferred sets are read with requirements.read)`);
        if (set && !requirementSet(set)) errors.push(`steps.${s.id}.config.checks.${String(check.key)}: "${set}" must be a catalog requirement set`);
      }
    }
    if (s.node === "step.review" && typeof c.criteriaFrom === "string") {
      if (!requirementSet(c.criteriaFrom)?.items.some((i) => i.kind === "criterion")) errors.push(`steps.${s.id}.config.criteriaFrom: "${c.criteriaFrom}" must be a catalog requirement set with criteria`);
    }
    if (s.node === "step.decide") {
      const from = obj(c.categories).from;
      if (typeof from === "string" && !requirementSet(from)) errors.push(`steps.${s.id}.config.categories.from: "${from}" must be a catalog requirement set`);
    }
  }
  return errors;
}

// --- The whole draft ----------------------------------------------------------------

export type CheckedDraft = {
  type: DocumentTypeDefinition | null;
  workflow: WorkflowDefinition | null;
  requirementSets: RequirementSet[];
  validation: Validation;
};

/** Validate the normalized drafts. `workflow` undefined: the author saves the type only. */
export function validateDraft(type: unknown, workflow: unknown, sets: unknown[]): CheckedDraft {
  const validation = emptyValidation();
  const t = parseDefinition(type);
  if (!t.ok) validation.type.push(...t.errors);
  const typeDef = t.ok ? t.definition : null;
  const typeKey = typeDef?.key ?? String(obj(type).key ?? "");

  const parsedSets: RequirementSet[] = [];
  sets.forEach((raw, i) => {
    const r = parseRequirementSet(raw);
    const label = `requirementSets.${String(obj(raw).key ?? i)}`;
    if (!r.ok) {
      validation.requirementSets.push(...r.errors.map((e) => `${label}.${e}`));
      return;
    }
    if (!r.set.inferred || r.set.provenance.url) validation.requirementSets.push(`${label}: a learned set is inferred and has no URL`);
    if (!r.set.key.startsWith(TEAM_REQUIREMENT_SET_PREFIX)) validation.requirementSets.push(`${label}: a team set's key starts with "${TEAM_REQUIREMENT_SET_PREFIX}"`);
    if (typeKey && !r.set.appliesTo.includes(typeKey)) validation.requirementSets.push(`${label}.appliesTo: must name the type "${typeKey}"`);
    parsedSets.push(r.set);
  });
  if (sets.length > LEARN_MAX_REQUIREMENT_SETS) validation.requirementSets.push(`requirementSets: at most ${LEARN_MAX_REQUIREMENT_SETS}`);

  let wf: WorkflowDefinition | null = null;
  if (workflow !== undefined) {
    const w = parseWorkflowDefinition(workflow);
    if (!w.ok) validation.workflow.push(...w.errors);
    else {
      wf = w.definition;
      validation.workflow.push(...workflowRules(wf, typeDef, new Set(sets.map((s) => String(obj(s).key ?? "")))));
      validation.graph.push(
        ...validateGraph(compileWorkflow(wf))
          .filter((i) => i.severity === "error")
          .map((i) => (i.nodeId ? `${i.nodeId}: ${i.message}` : i.message)),
      );
    }
  }
  return { type: typeDef, workflow: wf, requirementSets: parsedSets, validation };
}

/** Every validation error as one list (for the repair round). */
export const allErrors = (v: Validation) => [...v.type.map((e) => `type.${e}`), ...v.workflow.map((e) => `workflow.${e}`), ...v.graph.map((e) => `workflow graph: ${e}`), ...v.requirementSets];

// --- Parts, differences, confidence ---------------------------------------------------

/** The model's parts with example indexes in range and short quotes. */
export function cleanParts(parts: LearnedPart[], exampleCount: number): LearnedPart[] {
  return parts.slice(0, 200).map((p) => ({
    path: p.path.slice(0, 300),
    note: p.note.slice(0, 500),
    from: p.from
      .filter((f) => Number.isInteger(f.example) && f.example >= 0 && f.example < exampleCount)
      .slice(0, 10)
      .map((f) => ({ example: f.example, heading: f.heading?.slice(0, 200) ?? null, quote: f.quote?.slice(0, 200) ?? null })),
    shared: exampleCount === 1 ? true : p.shared,
  }));
}

const normHeading = (h: string) =>
  h
    .toLowerCase()
    .replace(/^[\divxlc]+[.)]\s+|^[a-z][.)]\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Pure: with 2+ examples, the top headings only some examples have (the draft keeps what they all share). */
export function headingDifferences(examples: Pick<LearnExampleView, "index" | "headings">[]): ExampleDifference[] {
  if (examples.length < 2) return [];
  const top = examples.map((e) => {
    const min = Math.min(...e.headings.map((h) => h.level), 6);
    return new Map(e.headings.filter((h) => h.level <= min + 1).map((h) => [normHeading(h.text), h.text]));
  });
  const all = new Map<string, string>();
  top.forEach((m) => m.forEach((text, k) => k && !all.has(k) && all.set(k, text)));
  const out: ExampleDifference[] = [];
  for (const [k, text] of all) {
    const has = examples.filter((_, i) => top[i].has(k)).map((e) => e.index);
    if (has.length < examples.length) out.push({ aspect: "section", description: `“${text}” appears in ${has.length === 1 ? "one example" : "only some examples"}.`, examples: has });
  }
  return out;
}

/** The model's differences plus the heading comparison, without repeating a heading the model already reported. */
export function mergeDifferences(model: ExampleDifference[], examples: Pick<LearnExampleView, "index" | "headings">[]): ExampleDifference[] {
  const n = examples.length;
  const own = model
    .map((d) => ({ ...d, description: d.description.slice(0, 500), examples: d.examples.filter((i) => Number.isInteger(i) && i >= 0 && i < n) }))
    .slice(0, 30);
  const text = own.map((d) => d.description.toLowerCase()).join("\n");
  const extra = headingDifferences(examples).filter((d) => {
    const quoted = /“(.+)”/.exec(d.description)?.[1]?.toLowerCase() ?? "";
    return quoted && !text.includes(quoted);
  });
  return n < 2 ? [] : [...own, ...extra];
}

/** PLAN §6.11: one example is low confidence; two are medium unless they differ a lot; three or more sharing their structure are high. */
export function confidenceFor(exampleCount: number, differences: ExampleDifference[], parts: LearnedPart[]): { confidence: LearnConfidence; reason: string } {
  if (exampleCount <= 1) return { confidence: "low", reason: "One example: structure only, low confidence. Add more examples to learn what they share." };
  const sectionDiffs = differences.filter((d) => d.aspect === "section" || d.aspect === "order").length;
  const shared = parts.length ? parts.filter((p) => p.shared).length / parts.length : 0;
  const large = sectionDiffs >= 3 || differences.length > 6 || (parts.length > 0 && shared < 0.5);
  if (exampleCount === 2) {
    return large
      ? { confidence: "low", reason: "Two examples that differ a lot: only what they share was kept. Check the differences." }
      : { confidence: "medium", reason: "Two examples: the draft keeps what they share." };
  }
  return large
    ? { confidence: "medium", reason: `${exampleCount} examples with notable differences: the draft keeps what they share.` }
    : { confidence: "high", reason: `${exampleCount} examples sharing their structure.` };
}
