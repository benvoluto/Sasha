import { beforeEach, describe, expect, it, vi } from "vitest";

const { claudeJson } = vi.hoisted(() => ({ claudeJson: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson }));

import type { CheckResult, ClassifiedUnit, ExtractedItem, Finding, SimulationLog } from "../contract";
import { agreeTable } from "./agree";
import { NOT_ASSESSED, resultSeverity, stepCheck } from "./check";
import { paragraphUnits, stepClassify } from "./classify";
import { buildDecision, categoryResults, categoryValue, decideSchema, stepDecide, type CategoryResult, type Need } from "./decide";
import { snapshotDocument } from "./readers";
import { SIMULATED, stepSimulate } from "./simulate";
import { ctxFor, heading, makeDocument, nodeOf, para, resetStores, USAGE } from "./test-fixtures";

beforeEach(() => {
  resetStores();
  claudeJson.mockReset();
});

const content = [para("Intro line."), heading("Install", "inst", "install"), para("Run npm install."), para("You should see a success message."), heading("Configure", "conf", "configure"), para("Edit the config file.")];
const D = snapshotDocument({ id: "d", title: "How to", type_key: null, updated_at: "2026-10-08T00:00:00.000Z", content_json: { type: "doc", content }, content_text: "" }, null, 8000);
const item = (id: string, text: string): ExtractedItem => ({ id, fields: { text }, location: null, evidence: [] });

describe("step.check", () => {
  const checklist = [
    { key: "observable", label: "Observable acceptance", question: "Is there an observable acceptance criterion?", severity: "major", appliesTo: [] },
    { key: "vague", label: "No vague terms", question: "Does it avoid vague terms?", severity: "minor", appliesTo: [] },
  ];

  it("perItem: one result per check and item; unknown items dropped, missing answers not assessed, unsupported passes downgraded", async () => {
    const { doc } = await makeDocument({});
    claudeJson.mockResolvedValue({
      data: {
        results: [
          { check: "observable", item: "I1", status: "met", rationale: "Has a criterion.", evidence: [{ id: "inst", quote: "success message" }] },
          { check: "observable", item: "I2", status: "met", rationale: "Claimed.", evidence: [{ id: "S00000000.P1", quote: "" }] },
          { check: "vague", item: "I1", status: "not_met", rationale: "Says 'fast'.", evidence: [] },
          { check: "vague", item: "I7", status: "met", rationale: "Not an item.", evidence: [] },
        ],
      },
      usage: USAGE,
    });
    const out = (await stepCheck({ document: D, items: [item("I1", "Install is fast"), item("I2", "Login works")] }, nodeOf("step.check", { checklist, perItem: true }), ctxFor(doc.id))) as { results: CheckResult[]; findings: Finding[] };
    expect(claudeJson.mock.calls[0][0].task).toBe("workflow.check");
    expect(out.results.map((r) => [r.check, r.itemId, r.status])).toEqual([
      ["observable", "I1", "met"],
      ["observable", "I2", "not_met"],
      ["vague", "I1", "not_met"],
      ["vague", "I2", NOT_ASSESSED],
    ]);
    expect(out.results[0].evidence[0]).toMatchObject({ kind: "document", ref: "inst", verified: true });
    expect(out.findings.map((f) => [f.id, f.kind, f.severity])).toEqual([
      ["n1:1", "observable", "major"],
      ["n1:2", "vague", "minor"],
      ["n1:3", NOT_ASSESSED, "minor"],
    ]);
  });

  it("reads an earlier step's outcome table (the agreed matrix) as data, and cites it", async () => {
    const { doc } = await makeDocument({});
    const matrix = agreeTable("agree", { agreed: [{ item: "O1|C1", label: "Option A — Cost", verdict: "strong", positions: [{ reviewer: "a", label: "A", verdict: "strong", score: null, rationale: "", evidence: [] }] as never }], disagreements: [], scores: [], findings: [] }, [{ key: "a", label: "Reviewer A" }]);
    claudeJson.mockResolvedValue({ data: { results: [{ check: "observable", item: null, status: "met", rationale: "Matches.", evidence: [{ id: "step:agree", quote: "strong" }] }] }, usage: USAGE });
    const out = (await stepCheck({ document: D, data: matrix }, nodeOf("step.check", { checklist: [checklist[0]] }), ctxFor(doc.id))) as { results: CheckResult[] };
    const prompt = claudeJson.mock.calls[0][0].user as string;
    expect(prompt).toContain('<table id="step:agree" name="Reviewer agreement"');
    expect(prompt).toContain("Option A — Cost\tstrong\tAgreed");
    expect(out.results[0]).toMatchObject({ status: "met", evidence: [{ kind: "data", ref: "step:agree", sourceId: null, verified: true }] });
  });

  it("perItem with no items makes no call", async () => {
    const { doc } = await makeDocument({});
    const out = (await stepCheck({ document: D }, nodeOf("step.check", { checklist, perItem: true }), ctxFor(doc.id))) as { results: unknown[] };
    expect(out.results).toEqual([]);
    expect(claudeJson).not.toHaveBeenCalled();
  });

  it("a full failure takes the question's severity; a partial one the milder of the two", () => {
    const q = { key: "k", label: "K", question: "?", severity: "blocking" as const, appliesTo: [] };
    expect(resultSeverity({ key: "not_met", label: "", ok: false, severity: "major" }, q)).toBe("blocking");
    expect(resultSeverity({ key: "partly_met", label: "", ok: false, severity: "minor" }, q)).toBe("minor");
    expect(resultSeverity({ key: "partly_met", label: "", ok: false, severity: "minor" }, { ...q, severity: "info" })).toBe("info");
  });
});

describe("step.classify", () => {
  it("numbers paragraphs per section (top-level blocks; before the first heading is doc#n)", () => {
    expect(paragraphUnits({ type: "doc", content }).map((u) => [u.id, u.sectionId])).toEqual([
      ["doc#1", null],
      ["inst#1", "inst"],
      ["inst#2", "inst"],
      ["conf#1", "conf"],
    ]);
  });

  it("flags units in flagged categories with the suggestion as the fix", async () => {
    const { doc } = await makeDocument({ content });
    claudeJson.mockResolvedValue({ data: { units: [{ id: "inst#1", category: "step", rationale: "An action." }, { id: "inst#2", category: "explanation", rationale: "Explains." }, { id: "nope#1", category: "step", rationale: "" }] }, usage: USAGE });
    const categories = [
      { key: "step", label: "Step", description: "An action", flag: false, severity: "info", suggestion: "" },
      { key: "explanation", label: "Explanation", description: "Why things are", flag: true, severity: "minor", suggestion: "an explanation" },
    ];
    const out = (await stepClassify({}, nodeOf("step.classify", { categories }), ctxFor(doc.id))) as { classified: ClassifiedUnit[]; findings: Finding[] };
    expect(claudeJson.mock.calls[0][0].user).toContain('<item id="inst#2" heading="Install">');
    expect(out.classified.map((c) => [c.unitId, c.category])).toEqual([
      ["inst#1", "step"],
      ["inst#2", "explanation"],
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ kind: "explanation", fix: "Move this to an explanation.", location: { sectionId: "inst" } });
  });
});

describe("step.simulate", () => {
  it("is never executed; every finding is unverified and a stop is walkthrough_failed", async () => {
    const { doc } = await makeDocument({});
    claudeJson.mockResolvedValue({
      data: {
        steps: [
          { step: "Run npm install", stated: "a success message", observed: "a success message", ok: true, note: "", section_id: "inst", quote: "Run npm install." },
          { step: "Edit the config file", stated: "", observed: "Which file?", ok: false, note: "No path given.", section_id: "conf", quote: "Edit the config file." },
        ],
        stopped_at: "Edit the config file",
        gaps: [{ title: "Config path missing", detail: "No path.", severity: "major", section_id: "conf", quote: "Edit the config file." }],
        answers: [],
      },
      usage: USAGE,
    });
    const out = (await stepSimulate({ document: D }, nodeOf("step.simulate", { records: "steps" }), ctxFor(doc.id))) as { log: SimulationLog; findings: Finding[] };
    expect(out.log.executed).toBe(false);
    expect(out.log.stoppedAt).toBe("Edit the config file");
    expect(out.findings.map((f) => f.kind)).toEqual(["walkthrough_failed", "walkthrough_step", "walkthrough_gap"]);
    for (const f of out.findings) {
      expect(f.verified).toBe(false);
      expect(f.detail.startsWith(SIMULATED)).toBe(true);
      expect(f.evidence.every((e) => !e.verified)).toBe(true);
    }
    expect(out.findings[0].location?.sectionId).toBe("conf");
  });
});

describe("step.decide", () => {
  it("is constrained to its values and keeps only cited ids that exist", async () => {
    expect(decideSchema(["ready", "not_ready"]).safeParse({ value: "maybe", rationale: "", cited: [] }).success).toBe(false);
    const { doc } = await makeDocument({});
    const finding = { id: "check:1", nodeId: "check", kind: "x", severity: "major", status: null, title: "A gap", detail: "", location: null, evidence: [], reviewer: null, verified: true, fix: "" };
    claudeJson.mockResolvedValue({ data: { value: "not_ready", rationale: "One major gap.", cited: ["check:1", "check:99"] }, usage: USAGE });
    const out = await stepDecide({ findings: [[finding]] }, nodeOf("step.decide", { values: ["ready", "not_ready"], guidance: "Be strict." }), ctxFor(doc.id));
    const call = claudeJson.mock.calls[0][0];
    expect(call.task).toBe("workflow.decide");
    expect(call.user).toContain('<item id="check:1">');
    expect(out).toEqual({ value: "not_ready", rationale: "One major gap.\n\nRests on: check:1." });
    expect(() => buildDecision({ value: "maybe", rationale: "", cited: [] }, { values: ["ready"], guidance: "g" }, { findings: [], agreed: [], disagreements: [], results: [], scores: [] })).toThrow(/unknown value/);
  });
});

describe("step.decide by category", () => {
  const cats = { from: "tx-19tac-89-1040", met: "criteria_met", metNoNeed: "criteria_met_no_need", notMet: "criteria_not_met", insufficient: "insufficient_evidence", metVerdict: "met", notMetVerdict: "not_met" };
  const pos = (reviewer: string, verdict: string | null) => ({ reviewer, label: reviewer, brief: "", verdict, score: null, rationale: "", evidence: [] });
  const agreed = (item: string, verdict: string) => ({ item, label: item, verdict, positions: [pos("a", verdict), pos("b", verdict)] });
  const disputed = (item: string) => ({ id: `agree:${item}`, nodeId: "agree", item, label: item, blocking: false, positions: [pos("a", "met"), pos("b", null)] });
  const values = ["criteria_met", "criteria_met_no_need", "criteria_not_met", "insufficient_evidence"];

  it("works out each rated category from the agreement on its criteria; unrated categories are left out", () => {
    const r = categoryResults(cats, {
      agreed: [agreed("specific_learning_disability", "met"), agreed("sld_exclusions", "met"), agreed("autism", "not_met"), agreed("speech_impairment", "insufficient_evidence")],
      disagreements: [disputed("other_health_impairment")],
    });
    expect(r.map((c) => [c.category, c.result])).toEqual([
      ["Autism", "not_met"],
      ["Other health impairment", "disputed"],
      ["Specific learning disability", "met"],
      ["Speech impairment", "insufficient"],
    ]);
    // A category with a criterion left unrated is not met.
    expect(categoryResults(cats, { agreed: [agreed("specific_learning_disability", "met")], disagreements: [] }).map((c) => c.result)).toEqual(["insufficient"]);
  });

  it("the overall value follows the categories: one weak category does not hide another's result", () => {
    const res = (...rs: Array<[string, CategoryResult["result"]]>): CategoryResult[] => rs.map(([category, result]) => ({ category, result, criteria: [], evidence: [] }));
    const needs = (...ns: Array<[string, Need]>) => new Map(ns);
    expect(categoryValue(cats, res(["SLD", "met"], ["OHI", "disputed"]), needs(["SLD", "needs_services"]))).toBe("criteria_met");
    expect(categoryValue(cats, res(["SLD", "met"], ["OHI", "disputed"]), needs(["SLD", "no_need"]))).toBe("insufficient_evidence");
    expect(categoryValue(cats, res(["SLD", "met"]), needs(["SLD", "unclear"]))).toBe("insufficient_evidence");
    expect(categoryValue(cats, res(["SLD", "met"], ["OHI", "not_met"]), needs(["SLD", "no_need"]))).toBe("criteria_met_no_need");
    expect(categoryValue(cats, res(["SLD", "not_met"], ["OHI", "not_met"]), needs())).toBe("criteria_not_met");
    expect(categoryValue(cats, [], needs())).toBe("insufficient_evidence");
  });

  it("asks the model only about need, sets the value in code, and returns a table by category", async () => {
    const { doc } = await makeDocument({});
    // The model names a need for a category that is not met: dropped.
    claudeJson.mockResolvedValue({ data: { needs: [{ category: "specific learning disability", need: "needs_services", rationale: "Needs reading instruction." }, { category: "Other health impairment", need: "needs_services", rationale: "x" }], rationale: "SLD met.", cited: [] }, usage: USAGE });
    const out = (await stepDecide(
      { agreed: [agreed("specific_learning_disability", "met"), agreed("sld_exclusions", "met")], disagreements: [disputed("other_health_impairment")] },
      nodeOf("step.decide", { values, guidance: "Judge need.", categories: cats }),
      ctxFor(doc.id),
    )) as { value: string; rationale: string; table: { rows: Array<{ cells: Record<string, string>; status: string }> } };
    const call = claudeJson.mock.calls[0][0];
    expect(call.user).not.toContain("Allowed values");
    expect(call.user).toContain("Judge need for: Specific learning disability");
    expect(out.value).toBe("criteria_met");
    expect(out.rationale).toBe("SLD met.");
    expect(out.table.rows.map((r) => [r.cells.category, r.status, r.cells.need])).toEqual([
      ["Other health impairment", "disputed", ""],
      ["Specific learning disability", "met", "Needs special education and related services"],
    ]);
  });
});
