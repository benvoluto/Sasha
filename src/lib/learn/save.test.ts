import { beforeEach, describe, expect, it, vi } from "vitest";

// The audit write fails for the action named here (a database error part way through a save).
const audit = vi.hoisted(() => ({ failOn: null as string | null }));
vi.mock("@/lib/ontology/governance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ontology/governance")>()),
  defaultAuditSink: () => ({
    write: async (e: { action: string }) => {
      if (e.action === audit.failOn) throw new Error("audit write failed");
    },
  }),
}));

import { getType } from "@/catalog";
import { resetCatalogStore } from "@/catalog/store";
import { resetMemoryStore } from "@/lib/documents/store";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { getWorkflow, listWorkflows, resetWorkflowStore } from "@/lib/workflow/store";
import { setsDraft, typeDraft, workflowDraft, EXAMPLE_A, EXAMPLE_B } from "./__fixtures__/learn-reply";
import { SaveLearnedRequest, type SaveLearnedBlocked } from "./contract";
import { saveLearned, bindDraft } from "./save";
import { insertTeamRequirementSets, listTeamRequirementSets, resetLearnStore } from "./store";
import { normalizeRequirementSets, normalizeType, normalizeWorkflow, remapSetKeys, type NormalizeContext } from "./validate";

const TEAM = "org:a";
const auth = { agent: "ann", permissions: [] };
const COPIED = "because the current unit failed its annual safety inspection last spring and cannot be repaired";

async function examples() {
  const a = await createSource(TEAM, "ann", { kind: "note", title: "A", extracted_text: EXAMPLE_A, extraction_status: "ready" });
  const b = await createSource(TEAM, "ann", { kind: "note", title: "B", extracted_text: EXAMPLE_B, extraction_status: "ready" });
  return [{ kind: "source" as const, sourceId: a.id }, { kind: "source" as const, sourceId: b.id }];
}

function request(refs: Awaited<ReturnType<typeof examples>>, opts: { type?: Record<string, unknown>; workflow?: Record<string, unknown> | null; keep?: string[] } = {}): SaveLearnedRequest {
  const ctx: NormalizeContext = { takenTypeKeys: new Set(), takenSetKeys: new Set(), exampleCount: 2, today: "2026-10-08" };
  const type = normalizeType(opts.type ?? typeDraft(), ctx);
  const { sets, keyMap } = normalizeRequirementSets(setsDraft(), String(type.key), ctx);
  const workflow = opts.workflow === null ? undefined : normalizeWorkflow(opts.workflow ?? workflowDraft(), String(type.key), keyMap, ctx);
  return SaveLearnedRequest.parse({ examples: refs, type, workflow, requirementSets: sets, reviewed: true, keepOverlaps: opts.keep ?? [] });
}

beforeEach(() => {
  audit.failOn = null;
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  resetSourceStore();
  resetCatalogStore();
  resetWorkflowStore();
  resetLearnStore();
});

describe("saveLearned", () => {
  it("saves the team type, its inferred sets and a team workflow bound to the type", async () => {
    const r = await saveLearned(TEAM, auth, request(await examples()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.type).toMatchObject({ key: "equipment-request", origin: "team" });
    expect(r.body.requirementSets).toEqual(["team-approvals"]);
    const entry = await getType(TEAM, "equipment-request");
    expect(entry?.definition.provenance).toMatchObject({ source: "Learned from 2 examples", license: "Team", url: "" });
    expect((await listTeamRequirementSets(TEAM)).map((s) => [s.key, s.inferred, s.appliesTo])).toEqual([["team-approvals", true, ["equipment-request"]]]);
    const [wf] = await listWorkflows(TEAM);
    expect(wf).toMatchObject({ id: r.body.workflow!.id, name: "Equipment request review", applies_to: "equipment-request" });
    const saved = await getWorkflow(TEAM, wf.id);
    expect(saved?.graph.nodes.find((n) => n.id === "req")?.config.sets).toEqual(["team-approvals"]);
    expect(saved?.note).toBe("Learned from 2 examples");
    // Nothing for another team.
    expect(await listTeamRequirementSets("org:b")).toEqual([]);
  });

  it("saves the type alone when no workflow is sent", async () => {
    const r = await saveLearned(TEAM, auth, request(await examples(), { workflow: null }));
    expect(r.ok && r.body.workflow).toBeNull();
    expect(await listWorkflows(TEAM)).toEqual([]);
  });

  it("refuses (422) a draft that doesn't validate, with the validation", async () => {
    const wf = workflowDraft();
    const steps = (wf.steps as Array<{ id: string; config?: object }>).map((s) => (s.id === "dec" ? { ...s, config: { values: ["approve", "reject"], guidance: "x" } } : s));
    const r = await saveLearned(TEAM, auth, request(await examples(), { workflow: { ...wf, steps } }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect((r as { body: SaveLearnedBlocked }).body.validation!.workflow.join(" ")).toMatch(/outcome values/);
    expect(await getType(TEAM, "equipment-request")).toBeNull();
  });

  it("refuses (422) copied text until the author keeps it on purpose", async () => {
    const refs = await examples();
    const type = typeDraft({ sections: [{ key: "summary", heading: "Summary", order: 10, guidance: `Explain ${COPIED}.`, elements: ["a", "b"] }, ...(typeDraft().sections as object[]).slice(1)] });
    const blocked = await saveLearned(TEAM, auth, request(refs, { type }));
    expect(blocked).toMatchObject({ ok: false, status: 422 });
    const body = (blocked as { body: SaveLearnedBlocked }).body;
    expect(body.overlaps.map((o) => o.path)).toEqual(["type.sections.summary.guidance"]);
    expect(body.error).toMatch(/copied from an example/);
    const kept = await saveLearned(TEAM, auth, request(refs, { type, keep: ["type.sections.summary.guidance"] }));
    expect(kept.ok).toBe(true);
  });

  it("refuses (422) personal details found in the draft, re-checked against the examples read on the server", async () => {
    const type = typeDraft({ preamble: "You write requests like Marisol Quintanilla Ortega does; reach her at marisol.q@example.org." });
    const r = await saveLearned(TEAM, auth, request(await examples(), { type }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    const body = (r as { body: SaveLearnedBlocked }).body;
    expect(body.personalDetails.map((p) => [p.kind, p.removed])).toEqual([
      ["email", false],
      ["name", false],
    ]);
  });

  it("checks the extraction's hints again at save, and lets the author keep a name (never a pattern)", async () => {
    const refs = await examples();
    // "Quintanilla" alone is no proper-noun span; only the model's hint finds it.
    const type = typeDraft({ preamble: "Write as Quintanilla would, plainly." });
    const hinted = { ...request(refs, { type }), personalHints: [{ text: "Quintanilla", kind: "name" as const }] };
    const r = await saveLearned(TEAM, auth, hinted);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect((r as { body: SaveLearnedBlocked }).body.personalDetails.map((p) => p.text)).toEqual(["Quintanilla"]);
    const kept = await saveLearned(TEAM, auth, { ...hinted, keepPersonal: ["Quintanilla"] });
    expect(kept.ok).toBe(true);

    const email = typeDraft({ key: "equipment-request-2", preamble: "Reach the lab at marisol.q@example.org." });
    const refused = await saveLearned(TEAM, auth, { ...request(refs, { type: email }), keepPersonal: ["marisol.q@example.org"] });
    expect((refused as { body: SaveLearnedBlocked }).body.personalDetails.map((p) => p.kind)).toEqual(["email"]);
  });

  it("returns 409 when the type's key is taken (and writes nothing more)", async () => {
    const refs = await examples();
    expect((await saveLearned(TEAM, auth, request(refs))).ok).toBe(true);
    const again = await saveLearned(TEAM, auth, request(refs));
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(await listWorkflows(TEAM)).toHaveLength(1);
  });

  it.each(["learn_type_saved", "create_workflow", "save_workflow_version"])("removes the bound workflow, the sets and the type when the %s write fails, so a retry saves one workflow", async (action) => {
    const refs = await examples();
    audit.failOn = action;
    await expect(saveLearned(TEAM, auth, request(refs))).rejects.toThrow(/audit write failed/);
    expect(await listWorkflows(TEAM)).toEqual([]);
    expect(await listTeamRequirementSets(TEAM)).toEqual([]);
    expect(await getType(TEAM, "equipment-request")).toBeNull();
    audit.failOn = null;
    expect((await saveLearned(TEAM, auth, request(refs))).ok).toBe(true);
    expect((await listWorkflows(TEAM)).map((w) => w.applies_to)).toEqual(["equipment-request"]);
  });

  it("rebuilds a type key (and a set key) that spells out a name from the title, whatever key the client sent", async () => {
    const refs = await examples();
    const req = request(refs);
    const sent = { ...req, type: { ...req.type, key: "equipment-request-marisol-quintanilla-ortega" }, requirementSets: req.requirementSets.map((s) => ({ ...s, key: "team-marisol-quintanilla-ortega" })), workflow: remapSetKeys(req.workflow!, new Map([["team-approvals", "team-marisol-quintanilla-ortega"]])) };
    const r = await saveLearned(TEAM, auth, sent);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.body.type.key).toBe("equipment-request");
    expect(r.body.requirementSets).toEqual(["team-equipment-request"]);
    expect((await listWorkflows(TEAM))[0].applies_to).toBe("equipment-request");
    // A name the author kept as not a person's leaves the key alone.
    resetCatalogStore();
    resetWorkflowStore();
    resetLearnStore();
    const keptKey = await saveLearned(TEAM, auth, { ...sent, keepPersonal: ["Marisol Quintanilla Ortega"] });
    expect(keptKey.ok && keptKey.body.type.key).toBe("equipment-request-marisol-quintanilla-ortega");
  });

  it("refuses examples that are not the team's", async () => {
    const refs = await examples();
    await expect(saveLearned("org:b", auth, request(refs))).rejects.toMatchObject({ status: 404 });
  });
});

describe("bindDraft", () => {
  it("re-applies the server's fields and keys inferred sets apart from the team's, remapping the workflow", async () => {
    const refs = await examples();
    const req = request(refs);
    const tampered = { ...req, type: { ...req.type, version: 9, provenance: { ...req.type.provenance, source: "Official NIH rules", license: "Public domain" } }, workflow: { ...req.workflow!, appliesTo: ["proposal"], fallback: true } };
    const b = bindDraft(tampered, 2, new Set(["team-approvals"]));
    expect(b.type).toMatchObject({ version: 1, provenance: { source: "Learned from 2 examples", license: "Team", url: "" } });
    expect(b.workflow).toMatchObject({ appliesTo: ["equipment-request"], fallback: false, kind: "type", requirementSets: ["team-approvals-2"] });
    expect(b.sets.map((s) => s.key)).toEqual(["team-approvals-2"]);
  });

  it("resets an inferred set's authority, dates, status and provenance, whatever the client sent", async () => {
    const req = request(await examples());
    const official = {
      ...req.requirementSets[0],
      version: 7,
      authority: "U.S. Department of Education",
      jurisdiction: "United States",
      effective: "2017-07-01",
      checked: "2020-01-01",
      status: "superseded" as const,
      supersedes: "idea-evaluation-34cfr",
      provenance: { source: "34 CFR 300.320", url: "", license: "Public domain (US government)" },
    };
    const [set] = bindDraft({ ...req, requirementSets: [official] }, 2, new Set(), "2026-10-08").sets;
    expect(set).toMatchObject({
      version: 1,
      authority: "Inferred from the team's examples",
      jurisdiction: "Team",
      effective: "",
      checked: "2026-10-08",
      status: "current",
      supersedes: null,
      inferred: true,
      appliesTo: ["equipment-request"],
      provenance: { source: "Learned from 2 examples", url: "", license: "Team" },
    });
  });

  it("saves under a fresh key when the team already has the set's key", async () => {
    const refs = await examples();
    const req = request(refs);
    await insertTeamRequirementSets(TEAM, "ann", [{ ...req.requirementSets[0], appliesTo: ["other-type"] }]);
    const r = await saveLearned(TEAM, auth, req);
    expect(r.ok && r.body.requirementSets).toEqual(["team-approvals-2"]);
    const [wf] = await listWorkflows(TEAM);
    expect((await getWorkflow(TEAM, wf.id))?.graph.nodes.find((n) => n.id === "req")?.config.sets).toEqual(["team-approvals-2"]);
  });
});
