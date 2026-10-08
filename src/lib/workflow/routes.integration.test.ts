// The Workflows tab's whole path, through the real route handlers, catalog,
// engine, step handlers and memory stores: list a document's workflows, start
// a run, poll it, decide at a checkpoint, apply the proposed change the way the
// editor does (planWorkflowChange + applyRestructurePlan), save it with
// type_source "restructure", and record the change and a finding response.
// Only the model calls (Claude, Gemini, web search), the sign-in and the audit
// sink are mocked; next/server's after() is captured so each test can await
// the background run.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  caller: { teamId: "org:test", agent: "tester@example.com", userId: "u1", orgId: "test", permissions: [] as string[] },
  pending: [] as Array<() => unknown>,
  claudeJson: vi.fn(),
  claudeText: vi.fn(),
  claudeSearch: vi.fn(),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void mocks.pending.push(fn) }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => mocks.caller, callerTeam: async () => mocks.caller }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson: mocks.claudeJson, claudeText: mocks.claudeText, claudeSearch: mocks.claudeSearch }));
vi.mock("@/lib/gemini", () => {
  throw new Error("Gemini must not be called by a workflow run");
});

import { fileTypeByKey } from "@/catalog/files";
import { sortedSections } from "@/catalog/schema";
import { builtInId } from "@/catalog/workflows";
import { planWorkflowChange } from "@/components/editor/apply-workflow-change";
import { startRequest } from "@/components/editor/workflows-pane-model";
import { PATCH as patchDocument } from "@/app/api/documents/[id]/route";
import { GET as listWorkflows, POST as startRun } from "@/app/api/documents/[id]/workflows/route";
import { POST as recordChange } from "@/app/api/workflow-runs/runs/[runId]/changes/route";
import { POST as continueRun } from "@/app/api/workflow-runs/runs/[runId]/continue/route";
import { POST as respondToFinding } from "@/app/api/workflow-runs/runs/[runId]/findings/route";
import { GET as getRunRoute } from "@/app/api/workflow-runs/runs/[runId]/route";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { getDocument } from "@/lib/documents/store";
import type { DocumentWorkflowsResponse, RunResponse, WorkflowRunView } from "./contract";
import { heading, makeDocument, para, resetStores, TEAM, USAGE } from "./nodes/test-fixtures";
import { applyRestructurePlan } from "./restructure";
import { resetWorkflowStore } from "./store";

type Call = { task: string; user: string };

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const docCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const runCtx = (runId: string) => ({ params: Promise.resolve({ runId }) });

/** Runs every after() callback queued so far (and any they queue), like the platform does once the response is sent. */
async function drain() {
  while (mocks.pending.length) await mocks.pending.shift()!();
}

async function available(docId: string) {
  const res = await listWorkflows(new Request(`http://x/api/documents/${docId}/workflows`), docCtx(docId));
  expect(res.status).toBe(200);
  return (await res.json()) as DocumentWorkflowsResponse;
}

async function start(docId: string, body: unknown): Promise<WorkflowRunView> {
  const res = await startRun(new Request(`http://x/api/documents/${docId}/workflows`, json(body)), docCtx(docId));
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as RunResponse;
  await drain();
  return poll(run.id);
}

async function poll(runId: string): Promise<WorkflowRunView> {
  const res = await getRunRoute(new Request(`http://x/api/workflow-runs/runs/${runId}`) as never, runCtx(runId));
  expect(res.status).toBe(200);
  return ((await res.json()) as RunResponse).run;
}

async function post<T>(handler: (r: never, c: ReturnType<typeof runCtx>) => Promise<Response>, runId: string, body: unknown, status = 200): Promise<T> {
  const res = await handler(new Request("http://x", json(body)) as never, runCtx(runId));
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

const failedSteps = (run: WorkflowRunView) => Object.entries(run.steps).filter(([, s]) => s.status === "failed");

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetStores();
  resetWorkflowStore();
  mocks.pending.length = 0;
  for (const m of [mocks.claudeJson, mocks.claudeText, mocks.claudeSearch]) m.mockReset();
  mocks.claudeText.mockRejectedValue(new Error("unexpected claudeText call"));
  mocks.claudeSearch.mockRejectedValue(new Error("unexpected web search"));
});

describe("general report support check, through the routes", () => {
  it("lists the type's workflow, runs it, links findings to passages and records a response", async () => {
    const content: PMNode[] = sortedSections(fileTypeByKey("general-report")!.sections).flatMap((s, i) => [heading(s.heading, `g${i}`, s.key), para(`About ${s.heading}: 1,250 households took part.`)]);
    const { doc, sources } = await makeDocument({ typeKey: "general-report", content, sources: [{ title: "Survey", summary: "Household survey.", passages: ["980 households took part in 2025."] }] });
    const passage = sources[0].passages[0];

    mocks.claudeJson.mockImplementation(async ({ task, user }: Call) => {
      switch (task) {
        case "workflow.extract":
          // ext lists one finding; recs (the recommendations) finds none.
          return user.startsWith("Extract every finding")
            ? { data: { items: [{ fields: { kind: "finding", text: "1,250 households took part", figure: "1,250" }, location: { section_id: "g2", quote: "1,250 households took part." }, source_passages: [] }] }, usage: USAGE }
            : { data: { items: [] }, usage: USAGE };
        case "workflow.trace":
          // tr1 (against the sources) contradicts the finding and cites the passage; tr2 has no recommendations to trace.
          return user.includes(passage.id)
            ? { data: { items: [{ id: "I1", status: "contradicted", evidence: [{ id: passage.id, quote: "980 households" }], linked_targets: [], rationale: "The survey reports 980." }] }, usage: USAGE }
            : { data: { items: [] }, usage: USAGE };
        case "workflow.check":
          return { data: { results: [] }, usage: USAGE };
        default:
          throw new Error(`unexpected model call: ${task}`);
      }
    });

    const list = await available(doc.id);
    const typeWorkflow = list.available.find((a) => a.kind === "type");
    expect(typeWorkflow).toMatchObject({ id: builtInId("type-general-report"), enabled: true });
    expect(list.available.map((a) => a.id)).toEqual(expect.arrayContaining([builtInId("restructure"), builtInId("draft-all"), builtInId("source-coverage")]));

    const run = await start(doc.id, { workflowId: typeWorkflow!.id });
    expect(failedSteps(run)).toEqual([]);
    expect(run.status).toBe("complete");
    expect(run.outcome).toMatchObject({ workflowKey: "type-general-report", value: "gaps_found", advisory: true });

    const contradicted = run.outcome!.findings.find((f) => f.severity === "major" && f.evidence.some((e) => e.kind === "passage"));
    expect(contradicted).toBeDefined();
    expect(contradicted!.evidence.find((e) => e.kind === "passage")).toMatchObject({ ref: passage.id, sourceId: sources[0].id, verified: true });

    const after = await post<RunResponse>(respondToFinding, run.id, { findingId: contradicted!.id, state: "accepted" });
    expect(after.run.responses[contradicted!.id]).toMatchObject({ state: "accepted", by: mocks.caller.agent });
    expect((await available(doc.id)).runs.map((r) => r.id)).toContain(run.id);
    expect(mocks.claudeText).not.toHaveBeenCalled();
    expect(mocks.claudeSearch).not.toHaveBeenCalled();
  });
});

describe("restructure, through the routes and the checkpoint", () => {
  const body = [para("Lead text."), heading("Money", "m1"), para("It costs $40,000."), heading("Trivia", "t1"), para("Unrelated.")];

  beforeEach(() => {
    mocks.claudeJson.mockImplementation(async ({ task }: Call) => {
      if (task === "restructure.plan") return { data: { rows: [{ id: "R1", target: null, reason: "" }, { id: "R2", target: "budget", reason: "Costs" }, { id: "R3", target: null, reason: "" }] }, usage: USAGE };
      throw new Error(`unexpected model call: ${task}`);
    });
  });

  it("pauses at the mapping, resumes with the edited plan, and the editor applies and saves it", async () => {
    const { doc } = await makeDocument({ typeKey: "general-report", content: body });
    const restructure = (await available(doc.id)).available.find((a) => a.id === builtInId("restructure"));
    expect(restructure).toMatchObject({ params: ["targetType", "mode"], checkpoint: { role: "Author", required: true } });

    // Waiting at the checkpoint, with the mapping table to review and no outcome yet.
    // The body the Workflows tab sends for its form.
    let run = await start(doc.id, startRequest(restructure!, { targetType: "proposal", mode: "merge", acknowledged: false }));
    expect(run.status).toBe("awaiting_review");
    expect(run.steps.cp.status).toBe("waiting");
    expect(run.outcome).toBeNull();
    expect(run.proposed).toEqual([]);

    // A bad decision is refused and leaves the run waiting.
    await post(continueRun, run.id, { checkpoint: { nodeId: "cp", verdict: "edit", edits: { targets: { R9: "budget" } } } }, 400);
    expect((await poll(run.id)).status).toBe("awaiting_review");

    // Edit one row's target and resume.
    await post(continueRun, run.id, { checkpoint: { nodeId: "cp", verdict: "edit", note: "Trivia is the rationale", edits: { targets: { R3: "reason" } } } }, 202);
    await post(continueRun, run.id, {}, 409);
    await drain();
    run = await poll(run.id);
    expect(failedSteps(run)).toEqual([]);
    expect(run.status).toBe("complete");
    expect(run.checkpoints.cp).toMatchObject({ verdict: "edit", by: mocks.caller.agent, role: "Author" });
    expect(run.outcome).toMatchObject({ value: "applied_plan" });
    expect(run.proposed).toHaveLength(1);
    const [change] = run.proposed;
    expect(change.snapshotReason).toBe("Before restructuring");

    // The editor's apply: one whole-document replacement, nothing lost.
    const current = (await getDocument(TEAM, doc.id))!;
    const planned = planWorkflowChange(current.content_json as PMNode, change, {
      sectionsFor: (key) => fileTypeByKey(key)?.sections ?? null,
      newId: (() => {
        let n = 0;
        return () => `new${++n}`;
      })(),
      restructure: applyRestructurePlan,
    });
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.typeKey).toBe("proposal");
    const text = JSON.stringify(planned.doc);
    for (const t of ["Lead text.", "It costs $40,000.", "Unrelated."]) expect(text).toContain(t);
    const headings = listSections(planned.doc).map((s) => s.specKey);
    expect(headings).toEqual(expect.arrayContaining(["budget", "reason"]));

    const saved = await patchDocument(new Request(`http://x/api/documents/${doc.id}`, { method: "PATCH", body: JSON.stringify({ content_json: planned.doc, type_key: planned.typeKey, type_source: "restructure" }) }), docCtx(doc.id));
    expect(saved.status).toBe(200);
    expect((await getDocument(TEAM, doc.id))!.type_key).toBe("proposal");

    const recorded = await post<RunResponse>(recordChange, run.id, { changeId: change.id, result: "applied", detail: "Restructured" });
    expect(recorded.run.changes[change.id]).toMatchObject({ result: "applied", by: mocks.caller.agent });
  });

  it("a rejection at the checkpoint proposes nothing", async () => {
    const { doc } = await makeDocument({ typeKey: "general-report", content: body });
    let run = await start(doc.id, { workflowId: builtInId("restructure"), params: { targetType: "proposal" } });
    expect(run.status).toBe("awaiting_review");
    await post(continueRun, run.id, { checkpoint: { nodeId: "cp", verdict: "reject", note: "Keep it as a report" } }, 202);
    await drain();
    run = await poll(run.id);
    expect(run.status).toBe("complete");
    expect(run.outcome).toMatchObject({ value: "rejected" });
    expect(run.steps.write.status).toBe("skipped");
    expect(run.proposed).toEqual([]);
  });
});
