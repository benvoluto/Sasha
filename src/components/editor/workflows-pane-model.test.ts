import { describe, expect, it } from "vitest";
import type { CheckpointConfig } from "@/lib/workflow/node-specs/core";
import type { AvailableWorkflow, EvidenceLink, Finding, Outcome, ProposedChange, RestructurePlan, WorkflowRunView } from "@/lib/workflow/contract";
import {
  AUTO_CONTINUE_MAX,
  POLL_MAX_MS,
  briefText,
  checkpointProblems,
  checkpointSignatures,
  checkpointText,
  chipApplyAction,
  computedLine,
  continueBody,
  decidedTargets,
  decidedText,
  evidenceLabel,
  findingsBySeverity,
  findingsRespondable,
  groupAvailable,
  changeWarnings,
  mappingDropped,
  mappingGaps,
  mappingRows,
  missingInputs,
  pendingChanges,
  pendingSigners,
  pollDelay,
  progressText,
  restructurePrefill,
  runPlan,
  runStatusText,
  scoreText,
  shouldAutoContinue,
  signatureText,
  startBlocker,
  startRequest,
  stepRows,
  canvasSelection,
  waitingCheckpoints,
  webHref,
  type CheckpointDraft,
} from "./workflows-pane-model";

const wf = (over: Partial<AvailableWorkflow>): AvailableWorkflow => ({
  id: "builtin:x",
  key: "x",
  title: "X",
  summary: "",
  kind: "generic",
  version: 1,
  outcome: { label: "Result", values: [{ key: "sound", label: "Sound" }] },
  checkpoint: null,
  params: [],
  enabled: true,
  disabledReason: null,
  acknowledge: null,
  requirementSets: [],
  latestRun: null,
  ...over,
});

const link = (over: Partial<EvidenceLink>): EvidenceLink => ({ kind: "passage", ref: "S1a2b3c4d.P3", sourceId: "src", label: "", quote: "", page: null, stance: "neutral", verified: true, ...over });

const run = (over: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
  id: "r1",
  document_id: "d1",
  status: "running",
  pause_reason: null,
  workflow_id: "builtin:x",
  workflow_name: "X",
  workflow_version: 1,
  graph: { format: "graph-v1", nodes: [], edges: [] },
  params: {},
  steps: {},
  outputs: {},
  checkpoints: {},
  outcome: null,
  changes: {},
  responses: {},
  requested_by: "a@b.c",
  created_at: "2026-10-08T10:00:00.000Z",
  updated_at: "2026-10-08T10:00:00.000Z",
  proposed: [],
  ...over,
});

const node = (id: string, type: string, config: Record<string, unknown> = {}, label?: string) => ({ id, type, position: { x: 0, y: 0 }, config, loop: false, expanded: false, ...(label ? { label } : {}) });

describe("the list", () => {
  it("groups this type's workflows first, then generic, then the team's, dropping empty groups", () => {
    const groups = groupAvailable([wf({ id: "g1", kind: "generic" }), wf({ id: "t1", kind: "team" }), wf({ id: "y1", kind: "type" }), wf({ id: "g2", kind: "generic" })]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ["For this type", ["y1"]],
      ["For any document", ["g1", "g2"]],
      ["Your team's workflows", ["t1"]],
    ]);
    expect(groupAvailable([wf({ kind: "generic" })]).map((g) => g.kind)).toEqual(["generic"]);
  });

  it("names the checkpoint role", () => {
    expect(checkpointText(wf({ checkpoint: { role: "Supervisor", required: true } }))).toBe("Signed off by: Supervisor");
    expect(checkpointText(wf({}))).toBeNull();
  });

  it("puts statuses in words, reading old draft rows as complete", () => {
    expect(runStatusText("complete")).toBe("Complete");
    expect(runStatusText("draft")).toBe("Complete");
    expect(runStatusText("awaiting_review")).toBe("Waiting for review");
    expect(runStatusText("superseded")).toBe("Replaced by a later run");
  });

  it("summarizes a brief's outcome", () => {
    const brief = { status: "complete" as const, outcome: { value: "gaps_found", valueLabel: "Gaps found", advisory: true, verdict: null, signedBy: null, signedAt: null } };
    expect(briefText(brief)).toBe("Gaps found · Advisory");
    expect(briefText({ ...brief, outcome: { ...brief.outcome, advisory: false, verdict: "approve" as const } })).toBe("Gaps found · Signed");
    expect(briefText({ ...brief, outcome: { ...brief.outcome, verdict: "reject" as const } })).toBe("Gaps found · Rejected");
    expect(briefText({ status: "running", outcome: null })).toBe("Running");
  });
});

describe("starting a run", () => {
  const form = { targetType: "", mode: "merge" as const, acknowledged: false };

  it("asks restructure for a target type and sends the mode", () => {
    const r = wf({ id: "builtin:restructure", key: "restructure", params: ["targetType", "mode"] });
    expect(startBlocker(r, form)).toBe("Choose a type to restructure to.");
    expect(startBlocker(r, { ...form, targetType: "proposal" })).toBeNull();
    expect(startRequest(r, { ...form, targetType: "proposal", mode: "rewrite" })).toEqual({ workflowId: "builtin:restructure", version: 1, params: { targetType: "proposal", mode: "rewrite" } });
  });

  it("needs the acknowledgement for a policy-disabled workflow, and sends its key", () => {
    const off = wf({ enabled: false, disabledReason: "NIH policy", acknowledge: { key: "draft-all-policy", text: "I will write it myself." } });
    expect(startBlocker(off, form)).toMatch(/Tick the box/);
    expect(startBlocker(off, { ...form, acknowledged: true })).toBeNull();
    expect(startRequest(off, { ...form, acknowledged: true }).params).toEqual({ acknowledge: ["draft-all-policy"] });
    expect(startBlocker(wf({ enabled: false, disabledReason: "Choose a type first." }), form)).toBe("Choose a type first.");
  });

  it("sends no params for a plain workflow", () => {
    expect(startRequest(wf({}), form)).toEqual({ workflowId: "builtin:x", version: 1 });
  });
});

describe("polling and continuing", () => {
  it("polls every 2 s while running and every 10 s while awaiting review", () => {
    expect(pollDelay("running")).toBe(2000);
    expect(pollDelay("awaiting_review")).toBe(10_000);
    expect(pollDelay("complete")).toBeNull();
    expect(pollDelay("paused")).toBeNull();
  });

  it("keeps polling after failed polls, backing off to at most a minute", () => {
    expect(pollDelay("running", 1)).toBe(4000);
    expect(pollDelay("running", 3)).toBe(16_000);
    expect(pollDelay("awaiting_review", 9)).toBe(POLL_MAX_MS);
    expect(pollDelay("complete", 2)).toBeNull();
  });

  it("continues a budget pause on its own, at most 10 times per run", () => {
    const paused = { status: "paused" as const, pause_reason: "budget" as const };
    expect(shouldAutoContinue(paused, 0)).toBe(true);
    expect(shouldAutoContinue(paused, AUTO_CONTINUE_MAX - 1)).toBe(true);
    expect(shouldAutoContinue(paused, AUTO_CONTINUE_MAX)).toBe(false);
    expect(shouldAutoContinue({ status: "paused", pause_reason: "manual" }, 0)).toBe(false);
    expect(shouldAutoContinue({ status: "running", pause_reason: null }, 0)).toBe(false);
  });
});

describe("steps", () => {
  it("lists steps in graph order with loop progress", () => {
    const r = run({
      graph: { format: "graph-v1", nodes: [node("doc", "doc.read"), node("draft", "draft.section", {}, "Draft"), node("tr", "step.trace")], edges: [] },
      steps: { doc: { status: "done" }, draft: { status: "running", progress: { done: 3, total: 7 } } },
    });
    expect(stepRows(r).map((s) => [s.id, s.status, s.progress])).toEqual([
      ["doc", "done", null],
      ["draft", "running", "3 of 7 sections"],
      ["tr", "pending", null],
    ]);
    expect(stepRows(r)[1].label).toBe("Draft");
    expect(stepRows(r)[1].items).toEqual([]);
    expect(progressText("step.trace", { done: 1, total: 4 })).toBe("1 of 4 items");
  });

  it("lists a looping step's items under it, with their states in words", () => {
    const items = [
      { label: "Summary", state: "done" as const, sectionId: "s1" },
      { label: "Budget", state: "running" as const, sectionId: "b1" },
      { label: "Item 3", state: "pending" as const },
      { label: "Risks", state: "failed" as const, sectionId: "r1" },
    ];
    const r = run({
      graph: { format: "graph-v1", nodes: [node("draft", "draft.section", {}, "Draft")], edges: [] },
      steps: { draft: { status: "running", progress: { done: 1, total: 4, items } } },
    });
    expect(stepRows(r)[0].items.map((i) => [i.label, i.stateText, i.sectionId])).toEqual([
      ["Summary", "Done", "s1"],
      ["Budget", "In progress", "b1"],
      ["Item 3", "Not started", null],
      ["Risks", "Failed", "r1"],
    ]);
    expect(new Set(stepRows(r)[0].items.map((i) => i.key)).size).toBe(4);
  });
});

describe("canvasSelection", () => {
  it("reads ?workflow= and its alias ?workflowId=, with an optional version", () => {
    expect(canvasSelection("?workflow=wf-1&version=3")).toEqual({ workflow: "wf-1", version: 3 });
    expect(canvasSelection("?workflowId=builtin%3Atype-fie")).toEqual({ workflow: "builtin:type-fie", version: undefined });
    expect(canvasSelection("?workflow=a&workflowId=b")).toEqual({ workflow: "a", version: undefined });
    expect(canvasSelection("?version=x")).toEqual({ workflow: undefined, version: undefined });
    expect(canvasSelection("")).toEqual({ workflow: undefined, version: undefined });
  });
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  workflowKey: "x",
  label: "Result",
  value: "sound",
  valueLabel: "Sound",
  values: [
    { key: "sound", label: "Sound" },
    { key: "gaps_found", label: "Gaps found" },
    { key: "blocked", label: "Blocked: missing input" },
  ],
  rationale: "",
  advisory: true,
  missing: [],
  incomplete: [],
  findings: [],
  agreed: [],
  disagreements: [],
  scores: [],
  computed: [],
  tables: [],
  notAssessed: [],
  notes: [],
  requirementSets: [],
  verdict: null,
  signedBy: null,
  signedAt: null,
  signedRole: null,
  originalValue: null,
  record: {},
  ...over,
});

describe("outcome card", () => {
  const fmt = (iso: string | null) => `<${iso}>`;

  it("shows who signed, as what role, and when; or who rejected", () => {
    expect(signatureText(outcome(), fmt)).toBeNull();
    expect(signatureText(outcome({ advisory: false, verdict: "approve", signedBy: "s@x.org", signedRole: "Supervisor", signedAt: "T" }), fmt)).toBe("Signed by s@x.org as Supervisor, <T>");
    expect(signatureText(outcome({ verdict: "reject", signedBy: "s@x.org", signedAt: "T" }), fmt)).toBe("Rejected by s@x.org, <T>");
  });

  it("reports scores with median, range and mean × 10, without averaging them into a verdict", () => {
    expect(scoreText({ item: "overall", label: "Overall", median: 4, min: 3, max: 6, meanTimes10: 43, nodeId: "a" })).toBe("Median 4 · range 3 to 6 · mean × 10: 43");
    expect(scoreText({ item: "f1", label: "F1", median: 2, min: 2, max: 2, meanTimes10: null, nodeId: "a" })).toBe("Median 2 · all 2");
  });

  it("marks approximate computed results as estimates", () => {
    const c = computedLine({ key: "len", label: "Research strategy length", ok: false, expected: "12 pages", actual: "13 pages", detail: "estimated from words", approximate: true, evidence: [] });
    expect(c).toMatchObject({ status: "failed", text: "13 pages (expected 12 pages)", estimate: true });
    expect(computedLine({ ...c, key: "x", label: "x", ok: null, expected: "", actual: "", detail: "", approximate: false, evidence: [] }).text).toBe("Couldn't compute");
  });

  it("gives missing inputs the gate's help text", () => {
    const r = run({ outputs: { gate: { report: { items: [], missing: [{ key: "consent", label: "Written consent", required: true, present: false, how: "none", evidence: [], help: "Link the signed consent form." }] } } } });
    expect(missingInputs(r, outcome({ value: "blocked", missing: ["Written consent", "Referral"] }))).toEqual([
      { label: "Written consent", help: "Link the signed consent form." },
      { label: "Referral", help: "" },
    ]);
  });
});

describe("findings and evidence", () => {
  const f = (id: string, severity: Finding["severity"]): Finding => ({ id, nodeId: "n", kind: "k", severity, status: null, title: id, detail: "", location: null, evidence: [], reviewer: null, verified: true, fix: "" });

  it("groups by severity, most severe first", () => {
    expect(findingsBySeverity([f("a", "minor"), f("b", "blocking"), f("c", "minor")]).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Blocking", ["b"]],
      ["Minor", ["a", "c"]],
    ]);
  });

  it("offers accept and dismiss only when the workflow has no checkpoint", () => {
    expect(findingsRespondable(run({ graph: { format: "graph-v1", nodes: [node("a", "step.check")], edges: [] } }))).toBe(true);
    expect(findingsRespondable(run({ graph: { format: "graph-v1", nodes: [node("cp", "checkpoint")], edges: [] } }))).toBe(false);
  });

  it("labels each kind of evidence chip", () => {
    expect(evidenceLabel(link({ label: "Annual report", page: 4 }))).toBe("Annual report · p. 4 · S1a2b3c4d.P3");
    expect(evidenceLabel(link({ kind: "web", ref: "https://www.example.org/a", label: "" }))).toBe("example.org");
    expect(evidenceLabel(link({ kind: "requirement", ref: "nih-page-limits#specific-aims", label: "Specific Aims: 1 page" }))).toBe("Specific Aims: 1 page");
    expect(evidenceLabel(link({ kind: "document", ref: "s1", label: "Methods" }))).toBe("Methods");
    expect(evidenceLabel(link({ kind: "note", ref: "notes" }))).toBe("Notes");
  });

  it("only opens http(s) web links", () => {
    expect(webHref(link({ kind: "web", ref: "https://example.org/x" }))).toBe("https://example.org/x");
    expect(webHref(link({ kind: "web", ref: "javascript:alert(1)" }))).toBeNull();
    expect(webHref(link({ kind: "passage" }))).toBeNull();
  });
});

describe("checkpoint", () => {
  const config: CheckpointConfig = {
    instructions: "Check it.",
    role: "Supervisor",
    signsOutcome: true,
    allowExclude: false,
    editable: "outcome",
    recordFields: [
      { key: "signed_name", label: "Name and credential", required: true },
      { key: "comment", label: "Comment", required: false },
    ],
    signers: [],
  };
  const draft = (over: Partial<CheckpointDraft> = {}): CheckpointDraft => ({ verdict: "approve", note: "", outcomeValue: "sound", targets: {}, record: {}, ...over });

  it("finds the waiting checkpoints", () => {
    const r = run({ graph: { format: "graph-v1", nodes: [node("cp", "checkpoint", config), node("x", "step.check")], edges: [] }, steps: { cp: { status: "waiting" } } });
    expect(waitingCheckpoints(r).map((c) => [c.id, c.config.role])).toEqual([["cp", "Supervisor"]]);
  });

  it("requires the required record fields to approve, but not to reject", () => {
    expect(checkpointProblems(config, draft())).toEqual(["Fill in “Name and credential”."]);
    expect(checkpointProblems(config, draft({ record: { signed_name: "  Dana, LSSP " } }))).toEqual([]);
    expect(checkpointProblems(config, draft({ verdict: "reject" }))).toEqual([]);
  });

  it("checks the edited value and Edit itself", () => {
    expect(checkpointProblems(config, draft({ verdict: "edit", outcomeValue: "nope", record: { signed_name: "D" } }), { values: ["sound", "gaps_found"] })).toEqual(["Choose one of the outcome's values."]);
    expect(checkpointProblems({ ...config, editable: "none", recordFields: [] }, draft({ verdict: "edit" }))[0]).toMatch(/can't be edited/);
  });

  it("checks mapping targets against the plan's rows and the type's sections", () => {
    const rows = { ...config, editable: "rows" as const, recordFields: [] };
    expect(checkpointProblems(rows, draft({ verdict: "edit", targets: { R1: "summary", R2: null } }), { rowIds: ["R1", "R2"], sectionKeys: ["summary"] })).toEqual([]);
    expect(checkpointProblems(rows, draft({ verdict: "edit", targets: { R9: "summary", R1: "bogus" } }), { rowIds: ["R1"], sectionKeys: ["summary"] })).toHaveLength(2);
  });

  it("sends only the edits the verdict uses", () => {
    const orig = { outcomeValue: "sound", targets: { R1: "summary" } };
    expect(continueBody("cp", config, draft({ record: { signed_name: " Dana ", comment: "" } }), orig)).toEqual({ nodeId: "cp", verdict: "approve", note: "", excluded: [], edits: { record: { signed_name: "Dana" } } });
    expect(continueBody("cp", config, draft({ verdict: "edit", outcomeValue: "gaps_found", record: { signed_name: "D" } }), orig).edits).toEqual({ outcomeValue: "gaps_found", record: { signed_name: "D" } });
    expect(continueBody("cp", config, draft({ verdict: "reject", note: " no ", record: { signed_name: "D" } }), orig)).toEqual({ nodeId: "cp", verdict: "reject", note: "no", excluded: [] });
    const rows = { ...config, editable: "rows" as const, recordFields: [] };
    expect(continueBody("cp", rows, draft({ verdict: "edit", targets: { R1: "summary", R2: null } }), { outcomeValue: null, targets: { R1: "summary", R2: "methods" } }).edits).toEqual({ targets: { R2: null } });
  });

  it("with named signers: asks who signs, sends it, and lists who is still to sign", () => {
    const signed = { ...config, recordFields: [], signers: [{ key: "owner", label: "Process owner" }, { key: "quality", label: "Quality approver" }] };
    expect(checkpointProblems(signed, draft())).toEqual(["Choose who you are signing as."]);
    expect(checkpointProblems(signed, draft({ signer: "owner" }))).toEqual([]);
    expect(continueBody("cp", signed, draft({ signer: "owner" }), { outcomeValue: "sound", targets: {} })).toMatchObject({ signer: "owner" });
    expect(continueBody("cp", config, draft({ signer: "owner", record: { signed_name: "D" } }), { outcomeValue: "sound", targets: {} })).not.toHaveProperty("signer");
    const r = run({ outputs: { cp: { pending_items: [], signatures: [{ signer: "owner", label: "Process owner", verdict: "approve", note: "", by: "a@x.org", at: "T", edits: null }, { nope: true }] } } });
    const sigs = checkpointSignatures(r, "cp");
    expect(sigs.map((g) => g.signer)).toEqual(["owner"]);
    expect(pendingSigners(signed, sigs).map((x) => x.key)).toEqual(["quality"]);
  });

  it("shows the mapping as decided: the plan's targets with the checkpoint's moves", () => {
    expect(decidedTargets({ R1: "a", R2: "b" }, { edits: { targets: { R1: "c" } } })).toEqual({ R1: "c", R2: "b" });
    expect(decidedTargets({ R1: "a" }, { edits: null })).toEqual({ R1: "a" });
  });

  it("says who decided and when", () => {
    expect(decidedText({ by: "s@x.org", at: "T", verdict: "approve" }, (i) => `<${i}>`)).toBe("Approved. Decided by s@x.org, <T>");
  });
});

describe("restructure mapping", () => {
  const plan: RestructurePlan = {
    targetType: "proposal",
    targetTitle: "Proposal",
    mode: "merge",
    basisUpdatedAt: "",
    blockHashes: ["a", "b", "c"],
    rows: [
      { id: "R1", from: 0, to: 0, heading: null, excerpt: "Dear team", target: null, reason: "Preamble" },
      { id: "R2", from: 1, to: 2, heading: "Budget", excerpt: "Costs…", target: "pricing", reason: "Money" },
    ],
    gaps: ["timeline"],
  };
  const sections = [
    { key: "pricing", heading: "Pricing" },
    { key: "timeline", heading: "Timeline" },
  ];

  it("finds the plan in the run's outputs", () => {
    expect(runPlan(run({ outputs: { plan: { plan, table: {} } } }))).toBe(plan);
    expect(runPlan(run())).toBeNull();
  });

  it("names each part, where it moves (with edits) and why", () => {
    expect(mappingRows(plan, sections).map((r) => [r.part, r.movesTo])).toEqual([
      ["Text before the first heading", "Kept word for word under “Content to place”"],
      ["Budget", "Pricing"],
    ]);
    expect(mappingRows(plan, sections, { R2: null })[1].movesTo).toMatch(/Content to place/);
    expect(mappingGaps(plan, sections)).toEqual(["Timeline"]);
    expect(mappingGaps(plan, sections, { R1: "timeline" })).toEqual([]);
  });

  it("warns, before apply, about headings with no text of their own (and not for plans stored before Phase 8)", () => {
    expect(mappingDropped(plan)).toBe("");
    const dropping = { ...plan, dropped: [{ index: 3, heading: "Overview", level: 2 }, { index: 5, heading: "Details", level: 2 }] };
    expect(mappingDropped(dropping)).toBe("These headings hold no text of their own and will be removed: “Overview”, “Details”.");
    const change = (p: RestructurePlan): ProposedChange => ({ id: "w", title: "Restructure", summary: "", ops: [{ op: "restructure", plan: p }], basisUpdatedAt: "", snapshotReason: "" });
    expect(changeWarnings(change(plan))).toEqual([]);
    expect(changeWarnings(change(dropping))).toEqual([mappingDropped(dropping)]);
  });
});

describe("proposed changes", () => {
  it("lists only changes with no result yet", () => {
    const change = (id: string): ProposedChange => ({ id, title: id, summary: "", ops: [], basisUpdatedAt: "", snapshotReason: "" });
    const r = run({ proposed: [change("w1"), change("w2")], changes: { w1: { result: "applied", by: "a", at: "t", detail: "" } } });
    expect(pendingChanges(r).map((c) => c.id)).toEqual(["w2"]);
  });
});

describe("classifier chip", () => {
  it("reads Apply on an untyped document and Restructure? on a typed one", () => {
    expect(chipApplyAction(null)).toEqual({ label: "Apply", restructure: false });
    expect(chipApplyAction("proposal")).toEqual({ label: "Restructure?", restructure: true });
  });

  it("prefills the restructure workflow with the chosen type", () => {
    expect(restructurePrefill("proposal")).toEqual({ workflowKey: "restructure", targetType: "proposal" });
  });
});
