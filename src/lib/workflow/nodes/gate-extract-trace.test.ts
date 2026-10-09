import { beforeEach, describe, expect, it, vi } from "vitest";

const { claudeJson } = vi.hoisted(() => ({ claudeJson: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson }));

import type { ExtractedItem, GateReport, TracedItem } from "../contract";
import type { FieldSpec, GateInput } from "../node-specs/steps";
import { buildItems, coerceField, extractSchema, stepExtract, type ExtractConfig } from "./extract";
import { gateReport, keywordGate, stepGate, withoutTemplateLines, type GateMaterial } from "./gate";
import { snapshotDocument } from "./readers";
import { ctxFor, heading, makeDocument, nodeOf, para, resetStores, USAGE } from "./test-fixtures";
import { stepTrace, applyTrace, type TraceConfig } from "./trace";
import type { DocSnapshot, SourcesSnapshot } from "./types";
import { EvidenceIndex, itemName } from "./util";

beforeEach(() => {
  resetStores();
  claudeJson.mockReset();
});

const gi = (over: Partial<GateInput> & Pick<GateInput, "key" | "kind">): GateInput => ({ label: over.key, match: [], specKeys: [], required: true, help: "", ...over });

function snapshot(content = [heading("Reason for Referral", "r1", "reason_for_referral"), para("Concerns about reading fluency were raised by the teacher.")], typeKey: string | null = "fie"): DocSnapshot {
  return snapshotDocument({ id: "d", title: "FIE", type_key: typeKey, updated_at: "2026-10-08T00:00:00.000Z", content_json: { type: "doc", content }, content_text: "" }, null, 8000);
}

describe("gate keyword logic (pure)", () => {
  const m: GateMaterial = {
    doc: snapshot(),
    sources: [{ id: "s1", title: "Signed consent form", kind: "file", role: null, summary: "Parent signature", status: "ready", url: null }],
    tables: [{ id: "t1", name: "Projections", sourceId: "s2", sourceTitle: "Model.xlsx", columns: [{ key: "c1", label: "Revenue", type: "number", unit: null }], rowCount: 1, rows: [["1"]] }],
    notes: { scratchpad: "Suspected disability: SLD", sections: [] },
  };

  it("finds each kind where the spec says", () => {
    const items = keywordGate(
      [
        gi({ key: "type", kind: "type" }),
        gi({ key: "consent", kind: "source", match: ["Consent"] }),
        gi({ key: "fin", kind: "data", match: [] }),
        gi({ key: "rev", kind: "data", match: ["revenue"] }),
        gi({ key: "referral", kind: "section", specKeys: ["reason_for_referral"] }),
        gi({ key: "susp", kind: "notes", match: ["suspected disability"] }),
        gi({ key: "conc", kind: "any", match: ["reading fluency"] }),
        gi({ key: "none", kind: "any", match: ["audiogram"] }),
        gi({ key: "opt", kind: "source", match: ["audiogram"], required: false }),
      ],
      m,
    );
    expect(items.map((i) => [i.key, i.present])).toEqual([
      ["type", true],
      ["consent", true],
      ["fin", true],
      ["rev", true],
      ["referral", true],
      ["susp", true],
      ["conc", true],
      ["none", false],
      ["opt", false],
    ]);
    expect(items[1].evidence[0]).toMatchObject({ kind: "source", ref: "s1" });
    expect(items[6].evidence[0]).toMatchObject({ kind: "document", ref: "doc" });
    const report = gateReport(items);
    // Optional inputs are reported, never missing.
    expect(report.missing.map((i) => i.key)).toEqual(["none"]);
  });

  it("an untyped document misses the type input; an empty section never matches", () => {
    const m2 = { ...m, doc: snapshot([heading("Reason for Referral", "r1", "reason_for_referral")], null) };
    const [type, sec] = keywordGate([gi({ key: "type", kind: "type" }), gi({ key: "sec", kind: "section", specKeys: ["reason_for_referral"] })], m2);
    expect(type.present).toBe(false);
    expect(sec.present).toBe(false);
  });
});

describe("gate and unfilled templates", () => {
  it("drops template lines whose value is still a placeholder, and keeps filled ones", () => {
    const text = ["Field\tEntry", "Most recent evaluation\t[YYYY-MM-DD]", "Eligibility category (from the evaluation)\t[Category]", "Date: [Date]", "[City, State] · [Phone]", "Last evaluation\t2023-11-12", "Re: Letter of inquiry: [project name], request of $[amount]", "Reads 58 words [correct] per minute."].join("\n");
    expect(withoutTemplateLines(text).split("\n")).toEqual(["Field\tEntry", "Last evaluation\t2023-11-12", "Re: Letter of inquiry: [project name], request of $[amount]", "Reads 58 words [correct] per minute."]);
  });

  it("cues match at word starts; acronyms must end the word", () => {
    const find = (text: string, word: string) => keywordGate([gi({ key: "k", kind: "any", match: [word] })], { doc: snapshot([para(text)]), sources: [], tables: [], notes: null })[0].present;
    expect(find("Needs identified in the classroom.", "FIE")).toBe(false);
    expect(find("Field\tEntry", "FIE")).toBe(false);
    expect(find("See the FIE of 2023.", "FIE")).toBe(true);
    expect(find("Two prior FIEs were reviewed.", "FIE")).toBe(true);
    expect(find("A reevaluation is due.", "evaluation")).toBe(false);
    expect(find("Earlier evaluations found a disability.", "evaluation")).toBe(true);
    expect(find("Submitted under NSF 25-512.", "NSF 2")).toBe(true);
    expect(find("The steps to install it.", "install")).toBe(true);
    expect(find("Installation takes a minute.", "install")).toBe(true);
  });

  it("an IEP scaffold row naming the evaluation doesn't satisfy the evaluation input", () => {
    const row = (a: string, b: string) => ({ type: "tableRow", content: [a, b].map((t) => ({ type: "tableCell", content: [para(t)] })) });
    const table = { type: "table", content: [row("Field", "Entry"), row("Most recent evaluation", "[YYYY-MM-DD]"), row("Person who can interpret evaluation results", "[Name]")] };
    const input = gi({ key: "evaluation", kind: "any", match: ["evaluation", "evaluation report"] });
    const empty = { doc: snapshot([heading("Plan Information", "p1", "plan-information"), table as never]), sources: [], tables: [], notes: null };
    expect(keywordGate([input], empty)[0].present).toBe(false);
    const filled = { ...empty, doc: snapshot([heading("Plan Information", "p1", "plan-information"), table as never, para("The evaluation report of 12 November 2023 found a reading disability.")]) };
    expect(keywordGate([input], filled)[0].present).toBe(true);
  });
});

describe("step.gate", () => {
  it("blocks on a missing required input without a model call", async () => {
    const { doc } = await makeDocument({ typeKey: null });
    const out = (await stepGate({ document: snapshot([], null) }, nodeOf("step.gate"), ctxFor(doc.id))) as Record<string, GateReport>;
    expect(out.pass).toBeUndefined();
    expect(out.blocked.missing.map((i) => i.key)).toEqual(["type"]);
    expect(claudeJson).not.toHaveBeenCalled();
  });

  it("asks the fast model only about keyword misses (never the type), and keeps a 'present' only with evidence it was shown", async () => {
    const { doc } = await makeDocument({ typeKey: "fie" });
    const inputs = [gi({ key: "type", kind: "type" }), gi({ key: "consent", kind: "any", match: ["written consent"] }), gi({ key: "data", kind: "any", help: "OHI needs a physician statement" })];
    claudeJson.mockResolvedValue({
      data: {
        inputs: [
          { key: "consent", present: true, evidence: [{ id: "S00000000", quote: "" }], why: "made up" },
          { key: "data", present: true, evidence: [{ id: "r1", quote: "Concerns about reading" }], why: "the referral section" },
        ],
      },
      usage: USAGE,
    });
    const out = (await stepGate({ document: snapshot() }, nodeOf("step.gate", { inputs, useModel: true }), ctxFor(doc.id))) as Record<string, GateReport>;
    const call = claudeJson.mock.calls[0][0];
    expect(call.task).toBe("workflow.gate");
    expect(call.user).toContain("- consent:");
    expect(call.user).not.toContain("- type:");
    expect(call).toMatchObject({ agent: "tester@example.com", documentId: doc.id, deadlineMs: expect.any(Number), timeoutMs: expect.any(Number) });
    const byKey = Object.fromEntries(out.report.items.map((i) => [i.key, i]));
    expect(byKey.consent.present).toBe(false);
    expect(byKey.data).toMatchObject({ present: true, how: "model" });
    expect(byKey.data.evidence[0]).toMatchObject({ kind: "document", ref: "r1", verified: true });
    expect(out.blocked.missing.map((i) => i.key)).toEqual(["consent"]);
  });
});

const fields: FieldSpec[] = [
  { name: "instrument", label: "Instrument", type: "text", description: "", required: true },
  { name: "score", label: "Score", type: "number", description: "", required: false },
  { name: "date", label: "Date", type: "date", description: "", required: false },
  { name: "area", label: "Area", type: "enum", values: ["reading", "math"], description: "", required: false },
  { name: "tags", label: "Tags", type: "list", description: "", required: false },
];

describe("extract (pure)", () => {
  it("builds a schema from the fields", () => {
    const s = extractSchema(fields);
    const ok = { items: [{ fields: { instrument: "WIAT-4", score: 85, date: "2026-09-01", area: "reading", tags: [] }, location: { section_id: null, quote: "" }, source_passages: [] }] };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ items: [{ ...ok.items[0], fields: { ...ok.items[0].fields, area: "music" } }] }).success).toBe(false);
    expect(s.safeParse({ items: [{ ...ok.items[0], fields: { ...ok.items[0].fields, score: "85" } }] }).success).toBe(false);
  });

  it("coerces values: dates to ISO, enum values outside the list to null", () => {
    expect(coerceField(fields[2], "September 1, 2026")).toBe("2026-09-01");
    expect(coerceField(fields[2], "soon")).toBeNull();
    expect(coerceField(fields[3], "music")).toBeNull();
    expect(coerceField(fields[4], null)).toEqual([]);
  });

  it("numbers items, checks the location quote against the document and drops passage ids it wasn't shown", () => {
    const d = snapshot([heading("Academic Functioning", "a1", "academic_functioning"), para("On the WIAT-4 reading composite she scored 85.")]);
    const sources: SourcesSnapshot = { sources: [{ id: "src-1", title: "Report", kind: "file", role: null, summary: "", status: "ready", url: null }], passages: [{ id: "Ssrc1.P1", sourceId: "src-1", page: 3, text: "WIAT-4 reading composite 85 (low average)." }] };
    const index = new EvidenceIndex({ doc: d, sources });
    const config = { item: "evidence", fields, instructions: "", from: ["document", "sources"], sectionKeys: [], sourceMatch: [], maxItems: 5 } as ExtractConfig;
    const items = buildItems(
      {
        items: [
          { fields: { instrument: "WIAT-4", score: 85 }, location: { section_id: "a1", quote: "she scored 85" }, source_passages: ["Ssrc1.P1", "Sfake.P9"] },
          { fields: { instrument: "KTEA" }, location: { section_id: "zzz", quote: "a sentence that is not there" }, source_passages: [] },
        ],
      },
      config,
      index,
    );
    expect(items.map((i) => i.id)).toEqual(["I1", "I2"]);
    expect(items[0].location).toMatchObject({ sectionId: "a1", heading: "Academic Functioning" });
    expect(items[0].evidence.map((e) => [e.kind, e.ref, e.verified])).toEqual([
      ["document", "a1", true],
      ["passage", "Ssrc1.P1", true],
    ]);
    expect(items[0].evidence[1]).toMatchObject({ sourceId: "src-1", page: 3 });
    expect(items[1].location?.sectionId).toBeNull();
    expect(items[1].evidence[0]).toMatchObject({ kind: "document", verified: false });
  });
});

describe("step.extract", () => {
  it("shows only sources matching sourceMatch, and drops passage ids from the others", async () => {
    const { doc, sources } = await makeDocument({
      sources: [
        { title: "RFP from the council", passages: ["Proposals must include a timeline."] },
        { title: "Old letter", passages: ["Unrelated."] },
      ],
    });
    const S: SourcesSnapshot = {
      sources: sources.map((s, i) => ({ id: s.id, title: i ? "Old letter" : "RFP from the council", kind: "note", role: null, summary: "", status: "ready", url: null })),
      passages: sources.flatMap((s) => s.passages.map((p) => ({ id: p.id, sourceId: s.id, page: p.page, text: p.text }))),
    };
    claudeJson.mockResolvedValue({ data: { items: [{ fields: { text: "Include a timeline", id: "R1" }, location: { section_id: null, quote: "Proposals must include a timeline." }, source_passages: [sources[0].passages[0].id, sources[1].passages[0].id] }] }, usage: USAGE });
    const node = nodeOf("step.extract", { item: "requirement", from: ["sources"], sourceMatch: ["rfp"], fields: [{ name: "text", label: "Text", type: "text", description: "" }, { name: "id", label: "Id", type: "text", description: "" }] });
    const out = (await stepExtract({ sources: S }, node, ctxFor(doc.id))) as { items: ExtractedItem[] };
    const user = claudeJson.mock.calls[0][0].user as string;
    expect(user).toContain("RFP from the council");
    expect(user).not.toContain("Old letter");
    expect(out.items[0].evidence.map((e) => e.ref)).toEqual([sources[0].passages[0].id]);
    expect(out.items[0].evidence[0].quote).toBe("Proposals must include a timeline.");
  });
});

const traceConfig = (over: Partial<TraceConfig> = {}) => nodeOf("step.trace", over);
const item = (id: string, text: string): ExtractedItem => ({ id, fields: { claim: text }, location: null, evidence: [] });

describe("step.trace", () => {
  it("against code: no model call, every item unverified (and its findings unverified)", async () => {
    const { doc } = await makeDocument({});
    const out = (await stepTrace({ items: [item("I1", "The cache is per region.")] }, traceConfig({ against: "code" }), ctxFor(doc.id))) as { traced: TracedItem[]; findings: Array<{ verified: boolean; status: string }> };
    expect(claudeJson).not.toHaveBeenCalled();
    expect(out.traced[0]).toMatchObject({ status: "unverified", linkedTargets: [] });
    expect(out.findings[0]).toMatchObject({ status: "unverified", verified: false });
  });

  it("against sources with none linked: no model call", async () => {
    const { doc } = await makeDocument({});
    const out = (await stepTrace({ items: [item("I1", "x")], sources: { sources: [], passages: [] } }, traceConfig(), ctxFor(doc.id))) as { traced: TracedItem[] };
    expect(claudeJson).not.toHaveBeenCalled();
    expect(out.traced[0].status).toBe("unverified");
  });

  it("maps target aliases back, drops unknown ids, downgrades unsupported passes and flags untraced targets (bothWays)", async () => {
    const { doc } = await makeDocument({});
    const items = [item("I1", "Requirement A"), item("I2", "Requirement B"), item("I3", "Requirement C")];
    const targets = [item("I1", "Goal X"), item("I2", "Goal Y")];
    claudeJson.mockResolvedValue({
      data: {
        items: [
          { id: "I1", status: "supported", evidence: [], linked_targets: ["T1"], rationale: "Serves goal X." },
          { id: "I2", status: "supported", evidence: [{ id: "S99999999.P1", quote: "" }], linked_targets: ["T7"], rationale: "Claims support." },
          { id: "I9", status: "supported", evidence: [], linked_targets: ["T2"], rationale: "Not an item." },
        ],
      },
      usage: USAGE,
    });
    const node = nodeOf("step.trace", { against: "targets", bothWays: true });
    const out = (await stepTrace({ items, targets }, node, ctxFor(doc.id))) as { traced: TracedItem[]; findings: Array<{ kind: string; title: string }> };
    expect(claudeJson.mock.calls[0][0].user).toContain('<item id="T1">');
    expect(out.traced.map((t) => [t.id, t.status, t.linkedTargets])).toEqual([
      ["I1", "supported", ["I1"]],
      ["I2", "unsupported", []],
      ["I3", "unverified", []],
    ]);
    expect(out.findings.filter((f) => f.kind === "untraced_target").map((f) => f.title)).toEqual(["Nothing links to: Goal Y"]);
  });

  it("notes, rather than flags, an unlinked target whose exempt field gives a reason (bothWays)", async () => {
    const { doc } = await makeDocument({});
    const goals = [item("I1", "Reads 90 words a minute")];
    const needs: ExtractedItem[] = [
      { id: "I1", fields: { need: "Reading fluency", reason_no_goal: "" }, location: null, evidence: [] },
      { id: "I2", fields: { need: "Fine motor", reason_no_goal: "Met through accommodations (pencil grip, keyboard)." }, location: null, evidence: [] },
      { id: "I3", fields: { need: "Math facts" }, location: null, evidence: [] },
    ];
    claudeJson.mockResolvedValue({ data: { items: [{ id: "I1", status: "supported", evidence: [], linked_targets: ["T1"], rationale: "Fluency goal." }] }, usage: USAGE });
    const node = nodeOf("step.trace", { against: "targets", bothWays: true, exemptField: "reason_no_goal" });
    const out = (await stepTrace({ items: goals, targets: needs }, node, ctxFor(doc.id))) as { findings: Array<{ kind: string; severity: string; title: string; detail: string }> };
    expect(out.findings.map((f) => [f.kind, f.severity, f.title])).toEqual([
      ["exempt_target", "info", "No link, reason stated: Fine motor"],
      ["untraced_target", "major", "Nothing links to: Math facts"],
    ]);
    expect(out.findings[0].detail).toMatch(/accommodations/);
  });

  it("applyTrace keeps verified passage support (pure)", () => {
    const S: SourcesSnapshot = { sources: [{ id: "a", title: "A", kind: "note", role: null, summary: "", status: "ready", url: null }], passages: [{ id: "Sa.P1", sourceId: "a", page: null, text: "Sales grew 12% in 2025." }] };
    const config = nodeOf("step.trace").config as TraceConfig;
    const m = { items: [item("I1", "Sales grew 12%")], targets: [], sources: S, doc: null, tables: [] };
    const [t] = applyTrace({ items: [{ id: "I1", status: "supported", evidence: [{ id: "[Sa.P1]", quote: "grew 12%" }], linked_targets: [], rationale: "ok" }] }, config, m, new EvidenceIndex({ sources: S }));
    expect(t.status).toBe("supported");
    expect(t.evidence[0]).toMatchObject({ kind: "passage", ref: "Sa.P1", sourceId: "a", verified: true, quote: "grew 12%" });
  });
});

describe("itemName", () => {
  const item = (fields: ExtractedItem["fields"]): ExtractedItem => ({ id: "I5", fields, location: null, evidence: [] });
  it("names an item by its name or text field, not a leading kind enum (a live trace finding read “Unsupported: budget_line”)", () => {
    expect(itemName(item({ kind: "budget_line", name: "Loaner laptops and hotspots", amount: 4600 }))).toBe("Loaner laptops and hotspots");
    expect(itemName(item({ kind: "requirement", id: "R2", text: "Export to CSV" }))).toBe("Export to CSV");
    expect(itemName(item({ kind: "budget_line", name: "", amount: 4600 }))).toBe("budget_line");
    expect(itemName(item({}))).toBe("I5");
  });
});
