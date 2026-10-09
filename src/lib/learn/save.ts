// The author checkpoint's save (PLAN §6.11): nothing learned is stored until
// the author has reviewed it against the examples. The server trusts nothing
// the client sends: it re-reads the examples, re-validates the drafts, re-runs
// the overlap and personal-detail checks, and refuses (422) while a copied run
// the author did not choose to keep, or a personal detail, remains. Then the
// type is created as a team type (createTeamType: a key or alias clash is
// 409), the inferred requirement sets are stored team-scoped, and the workflow
// is compiled and saved as a team workflow bound to the type. A failure part
// way removes what was already written.
//
// Server-only.

import { createTeamType, removeTypeEdits } from "@/catalog";
import { toTypeSummary, type DocumentTypeDefinition } from "@/catalog/schema";
import { typeKeyFromTitle, uniqueKey } from "@/catalog/from-outline";
import type { RequirementSet } from "@/catalog/requirements-schema";
import { defaultAuditSink, type Auth } from "@/lib/ontology/governance";
import { compileWorkflow } from "@/lib/workflow/compile";
import { createWorkflow, deleteWorkflow } from "@/lib/workflow/store";
import type { SaveLearnedBlocked, SaveLearnedRequest, SaveLearnedResponse } from "./contract";
import { readExamples, uniqueRefs } from "./examples";
import { findOverlaps, unacknowledgedOverlaps } from "./overlap";
import { findPersonalDetails, personalInKey, unkeptPersonalDetails } from "./personal";
import { deleteTeamRequirementSets, insertTeamRequirementSets } from "./store";
import { takenSetKeys, takenTypeKeys } from "./extract";
import { learnedSetFields, learnedSource, remapSetKeys, teamSetKey, validateDraft } from "./validate";

export type SaveLearnedResult = { ok: true; body: SaveLearnedResponse } | { ok: false; status: 409 | 422; body: SaveLearnedBlocked | { error: string } };

/**
 * The server-owned fields again (a client may have edited anything): Team
 * provenance, version 1, the workflow bound to the type, inferred sets keyed
 * apart from the catalog's and the team's existing sets (remapped in the
 * workflow) with the same server-owned fields as at extraction. A set key
 * that spells out a personal detail (`personalKey`) is replaced like a taken one;
 * the workflow's key is derived from the type's again.
 */
export function bindDraft(
  req: Pick<SaveLearnedRequest, "type" | "workflow" | "requirementSets">,
  exampleCount: number,
  takenSets: ReadonlySet<string>,
  today = new Date().toISOString().slice(0, 10),
  personalKey: (key: string) => boolean = () => false,
) {
  const type: DocumentTypeDefinition = {
    ...req.type,
    version: 1,
    provenance: { source: learnedSource(exampleCount), url: "", license: "Team", retrieved: req.type.provenance.retrieved },
  };
  const taken = new Set(takenSets);
  const keyMap = new Map<string, string>();
  const sets: RequirementSet[] = req.requirementSets.map((s) => {
    const key = personalKey(s.key) ? teamSetKey(type.key, type.key, taken) : taken.has(s.key) ? uniqueKey(s.key, taken) : s.key;
    taken.add(key);
    if (key !== s.key) keyMap.set(s.key, key);
    return { ...s, key, ...learnedSetFields(type.key, exampleCount, today) };
  });
  const workflow = req.workflow
    ? remapSetKeys({ ...req.workflow, key: `learned-${type.key}`.slice(0, 80).replace(/-+$/, ""), kind: "type" as const, appliesTo: [type.key], fallback: false, provenance: { source: learnedSource(exampleCount), checked: req.workflow.provenance.checked } }, keyMap)
    : undefined;
  return { type, workflow, sets };
}

export async function saveLearned(teamId: string, caller: Auth, req: SaveLearnedRequest): Promise<SaveLearnedResult> {
  const examples = await readExamples(teamId, uniqueRefs(req.examples));
  const texts = examples.map((e) => ({ text: e.text, headings: e.headings.map((h) => h.text) }));
  // Keys are not walked as prose, and the client may send any: a key that spells
  // out a name or organization (one the author has not kept) is rebuilt from the
  // title, which the personal-detail check below does read.
  const kept = new Set(req.keepPersonal.map((k) => k.trim()));
  const personalKey = (key: string) => personalInKey(key, texts, req.personalHints).some((t) => !kept.has(t));
  if (personalKey(req.type.key)) {
    const takenTypes = await takenTypeKeys(teamId);
    const fresh = uniqueKey(typeKeyFromTitle(req.type.title), takenTypes);
    req = { ...req, type: { ...req.type, key: personalKey(fresh) ? uniqueKey("team-type", takenTypes) : fresh } };
  }
  const { type, workflow, sets } = bindDraft(req, examples.length, await takenSetKeys(teamId), undefined, personalKey);

  const checked = validateDraft(type, workflow, sets);
  const v = checked.validation;
  const blocked = (error: string, extra: Partial<SaveLearnedBlocked> = {}): SaveLearnedResult => ({ ok: false, status: 422, body: { error, overlaps: [], personalDetails: [], ...extra } });
  if (v.type.length || v.workflow.length || v.graph.length || v.requirementSets.length || !checked.type) {
    return blocked("The draft doesn't validate yet. Fix the listed problems and save again.", { validation: v });
  }

  const draft = { type: checked.type, workflow: checked.workflow ?? undefined, requirementSets: checked.requirementSets };
  const overlaps = unacknowledgedOverlaps(
    findOverlaps(draft, examples.map((e) => e.text)),
    req.keepOverlaps,
  );
  // The extraction's hints count again (each must still appear in an example read here); a kept name or organization passes, a pattern never does.
  const personalDetails = unkeptPersonalDetails(
    findPersonalDetails(draft, texts, req.personalHints),
    req.keepPersonal,
  );
  if (overlaps.length || personalDetails.length) {
    const what = [overlaps.length ? "text copied from an example" : "", personalDetails.length ? "personal details" : ""].filter(Boolean).join(" and ");
    return blocked(`The draft still has ${what}. Remove ${overlaps.length && personalDetails.length ? "them" : "it"} (or keep a copied passage, or a name that is not a person's, on purpose) and save again.`, { overlaps, personalDetails });
  }

  const created = await createTeamType(teamId, caller.agent, checked.type);
  if (!created.ok) return { ok: false, status: 409, body: { error: created.message } };
  const typeKey = created.entry.definition.key;
  let setsSaved = false;
  let workflowId: string | null = null;
  try {
    if (!(await insertTeamRequirementSets(teamId, caller.agent, checked.requirementSets))) {
      await removeTypeEdits(teamId, caller.agent, typeKey);
      return { ok: false, status: 409, body: { error: "A requirement set with that key was just saved. Try again." } };
    }
    setsSaved = true;
    const saved = checked.workflow ? await createWorkflow(teamId, checked.workflow.title, compileWorkflow(checked.workflow), caller, { appliesTo: typeKey, note: learnedSource(examples.length) }) : null;
    workflowId = saved?.id ?? null;
    await defaultAuditSink().write({
      agent: caller.agent,
      action: "learn_type_saved",
      args: { examples: examples.length, documentId: req.documentId ?? null, keptOverlaps: req.keepOverlaps.length, keptPersonal: req.keepPersonal.length },
      result: { type: typeKey, workflow: saved?.id ?? null, requirementSets: checked.requirementSets.map((s) => s.key) },
      allowed: true,
    });
    return {
      ok: true,
      body: { type: toTypeSummary(created.entry), workflow: saved ? { id: saved.id, name: saved.name } : null, requirementSets: checked.requirementSets.map((s) => s.key) },
    };
  } catch (error) {
    // createWorkflow removes its own row when it fails part way; this covers a failure after it returned.
    if (workflowId) await deleteWorkflow(teamId, workflowId).catch(() => {});
    if (setsSaved) await deleteTeamRequirementSets(teamId, checked.requirementSets.map((s) => s.key)).catch(() => {});
    await removeTypeEdits(teamId, caller.agent, typeKey).catch(() => {});
    throw error;
  }
}
