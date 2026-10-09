// Learn a document type and a workflow from examples (PLAN §6.11): read the
// examples, one Opus call (learn.extract) with them as delimited data, then
// normalize and validate the drafts; when validation fails, one repair round
// with the errors (the examples are not sent again), if the function's time
// budget allows. Personal details are replaced by placeholders and long
// verbatim overlaps flagged before the draft goes to the author's checkpoint.
// Nothing is saved here (save.ts does that after the checkpoint).
//
// Server-only.

import { fileTypes, LEGACY_TYPE_ALIASES } from "@/catalog/files";
import { listTypes } from "@/catalog";
import { requirementSets as catalogSets } from "@/catalog/workflows";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import type { WorkflowDefinition } from "@/catalog/workflow-schema";
import type { RequirementSet } from "@/catalog/requirements-schema";
import { claudeJson, type ClaudeUsage } from "@/lib/llm/claude";
import type { LearnDraft, LearnExampleView, LearnRequest } from "./contract";
import { readExamples, uniqueRefs } from "./examples";
import { findOverlaps } from "./overlap";
import { personalInKey, scrubPersonalDetails, scrubText } from "./personal";
import { ExtractModelOutput, extractSystemPrompt, extractUserPrompt, RepairModelOutput, repairUserPrompt } from "./prompts";
import { listTeamRequirementSets } from "./store";
import {
  allErrors,
  cleanParts,
  confidenceFor,
  emptyValidation,
  mergeDifferences,
  normalizeRequirementSets,
  normalizeType,
  normalizeWorkflow,
  parseJsonText,
  validateDraft,
  type NormalizeContext,
  type Validation,
} from "./validate";

/** The first call's limit, leaving room in a 300 s function for a repair round. */
export const EXTRACT_DEADLINE_MS = 200_000;
/** The whole extraction's budget (the route's maxDuration less the reads, audit and response). */
export const LEARN_BUDGET_MS = 280_000;
/** A repair round needs at least this long; with less left the draft is returned with its errors. */
export const MIN_REPAIR_MS = 45_000;

/** The model's reply could not be turned into drafts at all. */
export class LearnModelError extends Error {}

/** Every type key and alias the team already uses (catalog, legacy aliases, team types, disabled ones too). */
export async function takenTypeKeys(teamId: string): Promise<Set<string>> {
  const taken = new Set<string>(Object.keys(LEGACY_TYPE_ALIASES));
  for (const f of fileTypes()) [f.key, ...f.aliases].forEach((k) => taken.add(k));
  for (const e of await listTypes(teamId, { includeDisabled: true })) [e.definition.key, ...e.definition.aliases].forEach((k) => taken.add(k));
  return taken;
}

/** Requirement set keys in use: the catalog's and the team's inferred sets. */
export async function takenSetKeys(teamId: string): Promise<Set<string>> {
  return new Set([...catalogSets().map((s) => s.key), ...(await listTeamRequirementSets(teamId)).map((s) => s.key)]);
}

type RawDrafts = { type: string; workflow: string; requirementSets: string };
type Built = { type: unknown; workflow: unknown; sets: unknown[]; checked: ReturnType<typeof validateDraft>; jsonErrors: string[] };

/** Parse, normalize and validate the three drafts. JSON that doesn't parse is a validation error like any other. */
export function buildDrafts(raw: RawDrafts, ctx: NormalizeContext, parts: LearnDraft["parts"]): Built {
  const jsonErrors: string[] = [];
  const t = parseJsonText(raw.type, "type");
  const w = parseJsonText(raw.workflow, "workflow");
  const r = parseJsonText(raw.requirementSets || "[]", "requirementSets");
  for (const p of [t, w, r]) if (!p.ok) jsonErrors.push(p.error);
  const type = normalizeType(t.ok ? t.value : {}, ctx, parts);
  const typeKey = String(type.key);
  const { sets, keyMap } = normalizeRequirementSets(r.ok ? r.value : [], typeKey, ctx);
  const workflow = normalizeWorkflow(w.ok ? w.value : {}, typeKey, keyMap, ctx);
  const checked = validateDraft(type, workflow, sets);
  return { type, workflow, sets, checked, jsonErrors };
}

const errorsOf = (b: Built): string[] => [...b.jsonErrors, ...allErrors(b.checked.validation)];

/** The draft's validation with JSON errors filed under the part they belong to. */
function validationOf(b: Built): Validation {
  const v = { ...emptyValidation(), ...b.checked.validation };
  for (const e of b.jsonErrors) {
    if (e.startsWith("type")) v.type = [e, ...v.type];
    else if (e.startsWith("workflow")) v.workflow = [e, ...v.workflow];
    else v.requirementSets = [e, ...v.requirementSets];
  }
  return v;
}

export type ExtractOptions = {
  agent: string;
  /** For tests: the clock the time budget reads. */
  now?: () => number;
  today?: string;
};

export type ExtractResult = { draft: LearnDraft; usage: ClaudeUsage[]; repaired: boolean };

/**
 * Read the examples and learn a draft type and workflow from them. Throws
 * LearnInputError (examples), LearnModelError (an unusable reply) or the
 * model's own errors (refusal, deadline).
 */
export async function learnFromExamples(teamId: string, req: LearnRequest, opts: ExtractOptions): Promise<ExtractResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const examples = await readExamples(teamId, uniqueRefs(req.examples));
  return extractFromExamples(teamId, examples, req, { ...opts, now, today, started });
}

/** The model part, once the examples are read (the evaluation harness calls this with fetched examples). */
export async function extractFromExamples(
  teamId: string,
  examples: LearnExampleView[],
  req: Pick<LearnRequest, "title" | "family" | "note" | "documentId">,
  opts: ExtractOptions & { started?: number },
): Promise<ExtractResult> {
  const now = opts.now ?? Date.now;
  const started = opts.started ?? now();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const ctx: NormalizeContext = {
    takenTypeKeys: await takenTypeKeys(teamId),
    takenSetKeys: await takenSetKeys(teamId),
    exampleCount: examples.length,
    today,
    title: req.title,
    family: req.family,
  };
  const system = extractSystemPrompt();
  const usage: ClaudeUsage[] = [];

  const first = await claudeJson({
    task: "learn.extract",
    system,
    user: extractUserPrompt(examples, req, today),
    schema: ExtractModelOutput,
    agent: opts.agent,
    documentId: req.documentId,
    deadlineMs: EXTRACT_DEADLINE_MS,
  });
  usage.push(first.usage);
  const out = first.data;
  const parts = cleanParts(out.parts, examples.length);
  let raw: RawDrafts = { type: out.type, workflow: out.workflow, requirementSets: out.requirementSets };
  // The author's title wins; else the model's (normalizeType falls back to the type JSON's own).
  if (!req.title && out.title.trim()) ctx.title = out.title.trim().slice(0, 120);
  let built = buildDrafts(raw, ctx, parts);
  let repaired = false;

  const left = LEARN_BUDGET_MS - (now() - started);
  if (errorsOf(built).length && left >= MIN_REPAIR_MS) {
    const fix = await claudeJson({
      task: "learn.extract",
      system,
      user: repairUserPrompt(raw, errorsOf(built), today),
      schema: RepairModelOutput,
      agent: opts.agent,
      documentId: req.documentId,
      deadlineMs: left - 10_000,
    });
    usage.push(fix.usage);
    raw = fix.data;
    built = buildDrafts(raw, ctx, parts);
    repaired = true;
  }
  if (built.jsonErrors.length === 3) throw new LearnModelError("The model's draft couldn't be read. Try again.");

  const texts = examples.map((e) => ({ text: e.text, headings: e.headings.map((h) => h.text) }));
  // The type key comes from the title and is not walked as prose: a name in the
  // title ("Evaluation Report for Jordan Alvarez") would survive in the key, the
  // sets' appliesTo and the workflow's key. Rebuild from the scrubbed title.
  const builtType = built.type as { key?: unknown; title?: unknown };
  if (personalInKey(String(builtType.key ?? ""), texts, out.personalDetails).length) {
    ctx.title = scrubText(String(builtType.title ?? ""), texts, out.personalDetails);
    built = buildDrafts(raw, ctx, parts);
  }

  // Personal details out first (the placeholders can't overlap an example), then the overlap check on what remains.
  const scrubbed = scrubPersonalDetails({ type: built.type as DocumentTypeDefinition, workflow: built.workflow as WorkflowDefinition, requirementSets: built.sets as RequirementSet[] }, texts, out.personalDetails);
  // Validate what the author will see (a placeholder can, rarely, push a field over its limit).
  const final = validateDraft(scrubbed.draft.type, scrubbed.draft.workflow, scrubbed.draft.requirementSets);
  const validation = validationOf({ ...built, checked: final });
  const draftParts = {
    type: final.type ?? scrubbed.draft.type,
    workflow: final.workflow ?? scrubbed.draft.workflow,
    requirementSets: final.type && !final.validation.requirementSets.length ? final.requirementSets : scrubbed.draft.requirementSets,
  };
  const differences = mergeDifferences(out.differences, examples);
  const { confidence, reason } = confidenceFor(examples.length, differences, parts);
  const nearest = out.nearestType ? fileTypes().find((t) => t.key === out.nearestType!.key) : null;

  const draft: LearnDraft = {
    examples,
    confidence,
    confidenceReason: reason,
    ...draftParts,
    parts,
    overlaps: findOverlaps(draftParts, examples.map((e) => e.text)),
    personalDetails: scrubbed.flags,
    differences,
    nearestType: nearest ? { key: nearest.key, title: nearest.title, reason: out.nearestType!.reason.slice(0, 500) } : null,
    validation,
  };
  return { draft, usage, repaired };
}
