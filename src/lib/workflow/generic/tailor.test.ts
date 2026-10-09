import { beforeEach, describe, expect, it, vi } from "vitest";

const { claudeJson } = vi.hoisted(() => ({ claudeJson: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson }));

import type { PMNode } from "@/lib/documents/sections";
import type { DocumentChangeOp, Finding, OutcomeTable, ReplaceLine, TracedItem } from "../contract";
import { documentLines, type DocLine } from "../lines";
import { MATERIAL_LINE } from "../nodes/prompts";
import { docRead, sourcesRead } from "../nodes/readers";
import { AGENT, ctxFor, heading, makeDocument, nodeOf, para, resetStores, USAGE } from "../nodes/test-fixtures";
import type { SourcesSnapshot } from "../nodes/types";
import resumeWorkflow from "@/catalog/workflows/type-resume-cv.json";
import { gateBoundSources, narrowedAway, narrowSources } from "../nodes/util";
import { applyTruth, checkTailorLines, eligibleLine, LEAD_NOT_IN_LIST, numberTokens, ONLY_GAPS, TAILOR_TRUTH, tailorLinesHandler, TRIM_HEADER, type TailorMaterial } from "./tailor";
import { TAILOR_SYSTEM, type TailorReply } from "./tailor-prompts";

beforeEach(() => {
  resetStores();
  claudeJson.mockReset();
});

type Out = Record<string, unknown>;

const bullets = (...texts: string[]): PMNode => ({ type: "bulletList", content: texts.map((t) => ({ type: "listItem", content: [para(t)] })) });

const body: PMNode[] = [
  heading("Contact", "c1", "contact"),
  para("Jane Doe · Austin, TX · jane@example.com"),
  heading("Experience", "e1", "experience"),
  para("Data Analyst, Acme Corp, 2019–2023"),
  bullets("Built weekly sales dashboards.", "Cleaned survey data for 1,250 households.", "Organized the office party."),
  heading("Skills", "k1", "skills"),
  para("SQL, Excel, Tableau"),
];

const S: SourcesSnapshot = {
  sources: [
    { id: "m1", title: "Master resume", kind: "note", role: null, summary: "", status: "ready", url: null },
    { id: "j1", title: "Analyst opening", kind: "note", role: "Job posting", summary: "", status: "ready", url: null },
    { id: "o1", title: "Old letter", kind: "note", role: null, summary: "", status: "ready", url: null },
  ],
  passages: [
    { id: "S00000001.P1", sourceId: "m1", page: 1, text: "Built weekly sales dashboards in Tableau used by 40 managers." },
    { id: "S00000001.P2", sourceId: "m1", page: 1, text: "Cleaned survey data for 1250 households using SQL." },
    { id: "S00000002.P1", sourceId: "j1", page: 1, text: "Lead a team of 12 analysts building Tableau dashboards." },
    { id: "S00000003.P1", sourceId: "o1", page: 1, text: "Unrelated." },
  ],
};

const reqs: Array<TracedItem> = [
  { id: "I1", fields: { requirement: "Tableau dashboards", priority: "required", kind: "skill" }, location: null, evidence: [], status: "direct", rationale: "", linkedTargets: [] },
  { id: "I2", fields: { requirement: "SQL", priority: "required", kind: "skill" }, location: null, evidence: [], status: "adjacent", rationale: "", linkedTargets: [] },
  { id: "I3", fields: { requirement: "People management", priority: "preferred", kind: "skill" }, location: null, evidence: [], status: "none", rationale: "", linkedTargets: [] },
];

const MASTER = { match: ["master", "resume"], exclude: ["job", "posting"] };

function material(over: Partial<TailorMaterial> = {}): TailorMaterial {
  const lines = documentLines({ type: "doc", content: body }).filter((l) => l.sectionId !== null && l.specKey !== "contact");
  return { lines, master: narrowSources(S, MASTER), requirements: reqs, maxLines: 25, ...over };
}
const ref = (m: TailorMaterial, text: string) => m.lines.find((l) => l.text.startsWith(text))!.ref;
type ReplyLine = TailorReply["lines"][number];
const reply = (...lines: Array<Partial<ReplyLine> & Pick<ReplyLine, "line">>): TailorReply => ({
  lines: lines.map((l) => ({ action: "rewrite" as const, text: "", reason: "Because.", requirements: [], support: [], ...l })),
});

/** The resume workflow's tailor step narrowing, as the catalog sets it. */
function resumeNarrow() {
  const tailor = resumeWorkflow.steps.find((x) => x.id === "tailor")!.config as { masterMatch: string[]; excludeSources: string[] };
  return { match: tailor.masterMatch, exclude: tailor.excludeSources };
}

/** A gate report binding each input key to these source ids. */
function gateReport(bound: Record<string, string[]>) {
  const items = Object.entries(bound).map(([key, ids]) => ({ key, label: key, required: true, present: true, how: "keyword", help: "", evidence: ids.map((id) => ({ kind: "source", ref: id, label: id, quote: "", sourceId: id, page: null, stance: "for", verified: true })) }));
  return { items, missing: [] };
}

describe("narrowSources", () => {
  it("keeps the matching sources less the excluded ones, with only their passages", () => {
    const m = narrowSources(S, MASTER)!;
    expect(m.sources.map((s) => s.id)).toEqual(["m1"]);
    expect(m.passages.map((p) => p.id)).toEqual(["S00000001.P1", "S00000001.P2"]);
    // An empty match keeps every source; the exclusion reads the role too.
    expect(narrowSources(S, { match: [], exclude: ["posting"] })!.sources.map((s) => s.id)).toEqual(["m1", "o1"]);
    expect(narrowSources(S, { match: [], exclude: [] })!.passages).toHaveLength(4);
    expect(narrowSources(null, MASTER)).toBeNull();
  });

  it("keeps a master whose title says 'jobs' or 'careers' under the resume's exclude phrases (word starts, never substrings)", () => {
    const { exclude, match } = resumeNarrow();
    const src = (id: string, title: string) => ({ id, title, kind: "note" as const, role: null, summary: "", status: "ready" as const, url: null });
    const snap: SourcesSnapshot = {
      sources: [src("a", "Master resume (all jobs)"), src("b", "Jane Doe CV - careers 2015-2025"), src("c", "Work history (all jobs)"), src("d", "Job description: Analyst"), src("e", "Resume writer job posting")],
      passages: [],
    };
    expect(narrowSources(snap, { match, exclude })!.sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(narrowSources(snap, { match: [], exclude })!.sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves out a posting titled with a master keyword: by the resume's exclude phrases, and by the source the gate bound as the job", () => {
    const { exclude, match } = resumeNarrow();
    const src = (id: string, title: string) => ({ id, title, kind: "note" as const, role: null, summary: "", status: "ready" as const, url: null });
    const snap: SourcesSnapshot = {
      sources: [src("p1", "Data Analyst position (LinkedIn)"), src("p2", "Resume Specialist (job ad)"), src("p3", "Acme careers: Resume Specialist"), src("m", "Master resume")],
      passages: [],
    };
    // "careers" stays off the exclude list (a master may be titled "Jane Doe CV - careers"), so the keywords alone keep p3...
    expect(narrowSources(snap, { match, exclude })!.sources.map((s) => s.id)).toEqual(["p3", "m"]);
    // ...but the gate bound it as the job, so it is left out by id.
    const report = gateReport({ job: ["p3"], master: ["p3", "m"] });
    expect(narrowSources(snap, { match, exclude, excludeIds: gateBoundSources(report, ["job"]) })!.sources.map((s) => s.id)).toEqual(["m"]);
  });

  it("gateBoundSources keeps a source bound as both job and master when it is the only master", () => {
    // "Jane Doe CV - careers 2015-2025" matches the job's "careers" and the master's "CV".
    expect([...gateBoundSources(gateReport({ job: ["cv", "jd"], master: ["cv"] }), ["job"])]).toEqual(["jd"]);
    expect([...gateBoundSources(gateReport({ job: ["p"], master: ["p", "m"] }), ["job"])]).toEqual(["p"]);
    expect([...gateBoundSources(gateReport({ job: ["p"] }), [])]).toEqual([]);
    expect([...gateBoundSources(undefined, ["job"])]).toEqual([]);
    const why = narrowedAway({ sources: [S.sources[0]], passages: [] }, { ...MASTER, excludeIds: new Set(["m1"]) });
    expect(why).toContain("the gate found as the job posting");
  });

  it("narrowedAway names the sources it left out, and is empty when any is kept or none is linked", () => {
    expect(narrowedAway(S, MASTER)).toBe("");
    expect(narrowedAway({ sources: [], passages: [] }, MASTER)).toBe("");
    const why = narrowedAway({ sources: [S.sources[1]], passages: [] }, MASTER);
    expect(why).toContain("“Analyst opening”");
    expect(why).toContain("master, resume");
    expect(why).toContain("job, posting");
  });
});

describe("numberTokens and eligibleLine", () => {
  it("normalizes numbers: commas and trailing dots stripped, percent kept", () => {
    expect(numberTokens("Grew sales 12.5% to $1,250,000. In 2021.")).toEqual(["12.5%", "1250000", "2021"]);
  });

  it("keeps a number's scale and marks, and reads spelled-out numbers, so a changed scale is a new number", () => {
    expect(numberTokens("$2K")).toEqual(["2000"]);
    expect(numberTokens("$2M")).toEqual(["2000000"]);
    expect(numberTokens("$2,000")).toEqual(["2000"]);
    expect(numberTokens("$1.2M and $1.2B")).toEqual(["1200000", "1200000000"]);
    expect(numberTokens("2 million users")).toEqual(["2000000"]);
    expect(numberTokens("3 years")).toEqual(["3"]);
    expect(numberTokens("3+ years")).toEqual(["3+"]);
    expect(numberTokens("30 percent, 10x faster")).toEqual(["30%", "10x"]);
    expect(numberTokens("a team of fifteen, twenty-five people, a dozen sites")).toEqual(["15", "25", "12"]);
    // "one" is a word more often than a count; digits inside a word (B2B) are no number.
    expect(numberTokens("One of the B2B leads")).toEqual([]);
  });

  it("reads a magnitude with no figure as a scale, and a period marker whole", () => {
    expect(numberTokens("Supported hundreds of clients")).toEqual(["~hundred"]);
    expect(numberTokens("dozens of teams, thousands of users, several million rows")).toEqual(["~dozen", "~thousand", "~million"]);
    expect(numberTokens("a thousand users")).toEqual(["1000"]);
    // A figure before the scale is read by the number, not twice.
    expect(numberTokens("1.2 million users")).toEqual(["1200000"]);
    expect(numberTokens("launched in Q4 2021")).toEqual(["Q4", "2021"]);
    expect(numberTokens("FY2022 H1")).toEqual(["FY2022", "H1"]);
    expect(numberTokens("an H1B visa")).toEqual([]);
  });

  it("never the preamble; static sections out unless sectionKeys names them", () => {
    const line = (specKey: string | null, sectionId: string | null = "x"): DocLine => ({ ref: "D1", path: [0], sectionId, heading: "H", specKey, text: "t", inList: false });
    const renderers = new Map([["contact", "static"], ["experience", "narrative"]]);
    expect(eligibleLine(line("experience", null), [], renderers)).toBe(false);
    expect(eligibleLine(line("contact"), [], renderers)).toBe(false);
    expect(eligibleLine(line("experience"), [], renderers)).toBe(true);
    expect(eligibleLine(line(null), [], renderers)).toBe(true);
    expect(eligibleLine(line("experience"), ["skills"], renderers)).toBe(false);
    expect(eligibleLine(line(null), ["skills"], renderers)).toBe(false);
    expect(eligibleLine(line("contact"), ["contact"], renderers)).toBe(true);
  });
});

describe("checkTailorLines", () => {
  it("drops a rewrite that turns a figure into a magnitude or moves a quarter", () => {
    const m = material();
    const support = [{ id: "S00000001.P1", quote: "used by 40 managers" }];
    const out = checkTailorLines(
      reply(
        { line: ref(m, "Built weekly"), text: "Built weekly sales dashboards used by hundreds of managers.", support },
        { line: ref(m, "Cleaned"), text: "Cleaned survey data for 1,250 households in Q2.", support: [{ id: "S00000001.P2", quote: "Cleaned survey data for 1250 households" }] },
      ),
      m,
    );
    expect(out.lines).toEqual([]);
    expect(out.dropped.map((d) => d.why)).toEqual(["It has a number that is not in the master (~hundred).", "It has a number that is not in the master (Q2)."]);
  });

  it("keeps a supported rewrite with the document's own text, section and heading", () => {
    const m = material();
    const d = ref(m, "Built weekly");
    const out = checkTailorLines(reply({ line: d, text: "Built weekly Tableau sales dashboards used by 40 managers.", requirements: ["I1", "I9"], support: [{ id: "S00000001.P1", quote: "used by 40 managers" }] }), m);
    expect(out.dropped).toEqual([]);
    expect(out.lines).toEqual([
      expect.objectContaining({
        id: "L1",
        action: "rewrite",
        sectionId: "e1",
        heading: "Experience",
        original: "Built weekly sales dashboards.",
        proposed: "Built weekly Tableau sales dashboards used by 40 managers.",
        requirementKeys: ["I1"],
      }),
    ]);
    expect(out.lines[0].evidence).toEqual([expect.objectContaining({ kind: "passage", ref: "S00000001.P1", sourceId: "m1", verified: true })]);
  });

  it("drops a ref it never showed (with a reason), and keeps only the first entry for a ref", () => {
    const m = material();
    const d = ref(m, "Built weekly");
    const support = [{ id: "S00000001.P1", quote: "Built weekly sales dashboards" }];
    const out = checkTailorLines(reply({ line: "D99", text: "Invented." }, { line: `[${d}]`, text: "Built weekly sales dashboards in Tableau.", support }, { line: d, action: "trim" }), m);
    expect(out.dropped).toEqual([{ line: expect.objectContaining({ proposed: "Invented." }), why: "Not a line Sasha showed." }]);
    expect(out.lines.map((l) => [l.id, l.action])).toEqual([["L1", "rewrite"]]);
  });

  it("does not show the contact line or the preamble, so they can't be changed", () => {
    const m = material();
    const contact = documentLines({ type: "doc", content: body }).find((l) => l.specKey === "contact")!;
    const out = checkTailorLines(reply({ line: contact.ref, text: "Jane Q. Doe" }), m);
    expect(out.lines).toEqual([]);
    expect(out.dropped[0].why).toBe("Not a line Sasha showed.");
  });

  it("cleans passage ids and citation markers out of the text, and drops an unchanged rewrite silently", () => {
    const m = material();
    const out = checkTailorLines(
      reply(
        { line: ref(m, "Built weekly"), text: "Built weekly Tableau dashboards [S00000001.P1] for 40 managers.", support: [{ id: "S00000001.P1", quote: "used by 40 managers" }] },
        { line: ref(m, "Cleaned"), text: "  Cleaned survey data for 1,250   households. " },
      ),
      m,
    );
    expect(out.lines.map((l) => l.proposed)).toEqual(["Built weekly Tableau dashboards for 40 managers."]);
    expect(out.dropped).toEqual([]);
  });

  it("trim empties the text and needs no evidence; a lead that only moves keeps the original and needs none", () => {
    const m = material();
    const out = checkTailorLines(reply({ line: ref(m, "Organized"), action: "trim", text: "anything" }, { line: ref(m, "Cleaned"), action: "lead", text: "Cleaned survey data for 1,250 households." }), m);
    expect(out.lines.map((l) => [l.id, l.action, l.proposed, l.evidence.length])).toEqual([
      ["L1", "trim", "", 0],
      ["L2", "lead", "Cleaned survey data for 1,250 households.", 0],
    ]);
  });

  it("drops new text with no verified master passage: none cited, an id it wasn't shown, an empty quote, the posting, or a quote not in the passage", () => {
    const m = material();
    const d = ref(m, "Built weekly");
    const cases: ReplyLine["support"][] = [[], [{ id: "S99999999.P1", quote: "" }], [{ id: "S00000001.P1", quote: "" }], [{ id: "S00000001.P1", quote: "  " }], [{ id: "S00000002.P1", quote: "Tableau dashboards" }], [{ id: "S00000001.P1", quote: "used by 400 directors" }]];
    for (const support of cases) {
      const out = checkTailorLines(reply({ line: d, text: "Built Tableau dashboards for managers.", support }), m);
      expect(out.lines, JSON.stringify(support)).toEqual([]);
      expect(out.dropped[0].why).toBe("No master passage supports it.");
    }
    // A lead with new text needs support too.
    const lead = checkTailorLines(reply({ line: d, action: "lead", text: "Built Tableau dashboards for managers." }), m);
    expect(lead.dropped[0]).toMatchObject({ line: { action: "lead" }, why: "No master passage supports it." });
  });

  it("drops a number that is in neither the line nor its passages (years included); commas don't matter", () => {
    const m = material();
    const support = [{ id: "S00000001.P2", quote: "Cleaned survey data for 1250 households" }];
    const ok = checkTailorLines(reply({ line: ref(m, "Cleaned"), text: "Cleaned survey data for 1,250 households using SQL.", support }), m);
    expect(ok.lines).toHaveLength(1);
    for (const text of ["Cleaned survey data for 1,500 households using SQL.", "Cleaned survey data for 1,250 households in 2022.", "Cleaned 95% of survey data for 1,250 households."]) {
      const out = checkTailorLines(reply({ line: ref(m, "Cleaned"), text, support }), m);
      expect(out.lines, text).toEqual([]);
      expect(out.dropped[0].why).toMatch(/^It has a number that is not in the master/);
      expect(out.dropped[0].line.evidence).toHaveLength(1);
    }
  });

  it("drops a lead outside a list and a trim of a header-like paragraph, so no achievement ends up under another employer", () => {
    const m = material();
    const out = checkTailorLines(
      reply(
        { line: ref(m, "Data Analyst, Acme"), action: "trim" },
        { line: ref(m, "SQL, Excel"), action: "lead", text: "SQL, Excel, Tableau" },
        { line: ref(m, "Built weekly"), action: "lead", text: "Built weekly sales dashboards." },
      ),
      m,
    );
    expect(out.lines.map((l) => [l.id, l.action, l.original])).toEqual([["L1", "lead", "Built weekly sales dashboards."]]);
    expect(out.dropped.map((d) => [d.line.original, d.why])).toEqual([
      ["Data Analyst, Acme Corp, 2019–2023", TRIM_HEADER],
      ["SQL, Excel, Tableau", LEAD_NOT_IN_LIST],
    ]);
    // A paragraph a list follows heads it, even with no number in it.
    const jobs = documentLines({ type: "doc", content: [heading("Experience", "e1", "experience"), para("Beta Inc, Engineer"), bullets("Led the Beta migration.")] });
    const header = checkTailorLines(reply({ line: "D1", action: "trim" }), material({ lines: jobs }));
    expect(header.dropped.map((d) => d.why)).toEqual([TRIM_HEADER]);
  });

  it("keeps only requirement keys the master meets, and drops a line that claims only a GAP", () => {
    const m = material();
    const support = [{ id: "S00000001.P1", quote: "used by 40 managers" }];
    const text = "Built weekly sales dashboards used by 40 managers.";
    const gap = checkTailorLines(reply({ line: ref(m, "Built weekly"), text, requirements: ["I3"], support }), m);
    expect(gap.lines).toEqual([]);
    expect(gap.dropped[0]).toMatchObject({ why: ONLY_GAPS, line: { requirementKeys: ["I3"] } });
    const mixed = checkTailorLines(reply({ line: ref(m, "Built weekly"), text, requirements: ["I1", "I3"], support }), m);
    expect(mixed.lines[0].requirementKeys).toEqual(["I1"]);
  });

  it("records which repeat of a duplicated line it is, so the editor changes the one the model meant", () => {
    const content = [heading("Experience", "e1", "experience"), para("Acme"), bullets("Led a team of 5 engineers"), para("Beta"), bullets("Led a team of 5 engineers")];
    const lines = documentLines({ type: "doc", content });
    const second = lines.filter((l) => l.text.startsWith("Led"))[1];
    const out = checkTailorLines(reply({ line: second.ref, action: "trim" }), material({ lines }));
    expect(out.lines[0]).toMatchObject({ original: "Led a team of 5 engineers", occurrence: 1, occurrences: 2 });
  });

  it("caps the list at maxLines in reply order and numbers it", () => {
    const m = material({ maxLines: 2 });
    const out = checkTailorLines(reply({ line: ref(m, "Organized"), action: "trim" }, { line: ref(m, "Cleaned"), action: "lead", text: "" }, { line: ref(m, "SQL"), action: "trim" }), m);
    expect(out.lines.map((l) => [l.id, l.original])).toEqual([
      ["L1", "Organized the office party."],
      ["L2", "Cleaned survey data for 1,250 households."],
    ]);
  });
});

describe("prompts", () => {
  it("treat a stronger role, scope or seniority than the master states as overstated, in the tailor and the truth check", () => {
    expect(TAILOR_TRUTH.question).toMatch(/led, managed or owned versus contributed to, assisted or supported/);
    expect(TAILOR_TRUTH.question).toMatch(/stronger verb or a bigger scope than the master states is overstated/);
    expect(TAILOR_SYSTEM).toMatch(/role, scope and seniority stay as the master states them/);
    expect(TAILOR_SYSTEM).not.toMatch(/or of its section/);
  });
});

describe("applyTruth", () => {
  it("drops lines whose status fails, keeps the trace's evidence (deduplicated) on the rest, and renumbers", () => {
    const passage = { kind: "passage" as const, ref: "S00000001.P1", sourceId: "m1", label: "Master resume", quote: "", page: 1, stance: "for" as const, verified: true };
    const line = (id: string): ReplaceLine => ({ id, action: "rewrite", sectionId: "e1", heading: "Experience", original: "o", proposed: "p", reason: "", requirementKeys: [], evidence: [passage] });
    const traced = (id: string, status: string): TracedItem => ({ id, fields: {}, location: null, evidence: [passage, passage], status, rationale: "Says 40.", linkedTargets: [] });
    const out = applyTruth([line("L1"), line("L2"), line("L3")], [traced("L1", "overstated"), traced("L2", "in_master")]);
    expect(out.lines.map((l) => [l.id, l.evidence.length])).toEqual([
      ["L1", 1],
      ["L2", 1],
    ]);
    expect(out.dropped).toEqual([{ line: expect.objectContaining({ id: "L1" }), why: "Says more than the master: Says 40.", status: "overstated" }]);
  });
});

// --- The handler ------------------------------------------------------------------------

async function resume(opts: { sources?: boolean; content?: PMNode[] } = {}) {
  const { doc, sources } = await makeDocument({
    typeKey: "resume-cv",
    content: opts.content ?? body,
    sources:
      opts.sources === false
        ? []
        : [
            { title: "Master resume", passages: ["Built weekly sales dashboards in Tableau used by 40 managers.", "Cleaned survey data for 1250 households using SQL."] },
            { title: "Analyst opening", role: "Job posting", passages: ["Lead a team of 12 analysts building Tableau dashboards."] },
          ],
  });
  const ctx = ctxFor(doc.id);
  const document = ((await docRead({}, nodeOf("doc.read"), ctx)) as Out).document;
  const src = ((await sourcesRead({}, nodeOf("sources.read"), ctx)) as Out).sources;
  return { doc, ctx, inputs: { document, sources: src, requirements: reqs }, master: sources[0], posting: sources[1] };
}

const tailorNode = (config: Record<string, unknown> = {}) => nodeOf("tailor.lines", { masterMatch: ["master", "resume"], excludeSources: ["job", "posting"], ...config }, "tailor");

describe("tailor.lines", () => {
  it("makes no model call with no master passages, no line it may change, or no requirement the master meets", async () => {
    const none = await resume({ sources: false });
    const cases: Array<[Record<string, unknown>, ReturnType<typeof tailorNode>, string]> = [
      [none.inputs, tailorNode(), "Nothing to tailor: no master history passages are linked"],
      [(await resume()).inputs, tailorNode({ sectionKeys: ["education"] }), "Nothing to tailor: the resume has no lines in the sections it may change"],
      [{ ...(await resume()).inputs, requirements: [reqs[2]] }, tailorNode(), "Nothing to tailor: no requirement has evidence in the master history"],
    ];
    for (const [inputs, node, title] of cases) {
      const out = (await tailorLinesHandler(inputs, node, none.ctx)) as Out;
      expect(out.op).toBeNull();
      expect(out.lines).toEqual([]);
      expect((out.findings as Finding[]).map((f) => [f.kind, f.severity, f.title])).toEqual([["tailor_summary", "info", title]]);
      expect((out.table as OutcomeTable).rows).toEqual([]);
    }
    expect(claudeJson).not.toHaveBeenCalled();
  });

  it("never reads the source the gate bound as the job as master history, whatever its title", async () => {
    const { ctx, inputs, master } = await resume();
    // As if "Master resume" were the posting the gate bound as the job (and another source the master).
    const gate = gateReport({ job: [master.id], master: [master.id, "other"] });
    const out = (await tailorLinesHandler({ ...inputs, gate }, tailorNode({ excludeBound: ["job"] }), ctx)) as Out;
    expect(out.op).toBeNull();
    const [f] = out.findings as Finding[];
    expect(f.title).toBe("Nothing to tailor: no master history passages are linked");
    expect(f.detail).toContain("the gate found as the job posting");
    expect(claudeJson).not.toHaveBeenCalled();
  });

  it("proposes the lines that pass the code checks and the truth check, and reports the rest", async () => {
    const { ctx, inputs, master, posting } = await resume();
    const [p1, p2] = master.passages.map((p) => p.id);
    const lines = documentLines((await ctx.document()).content_json);
    const at = (text: string) => lines.find((l) => l.text.startsWith(text))!.ref;
    claudeJson.mockImplementation(async (c: { task: string }) => {
      if (c.task === "workflow.tailor") {
        return {
          data: reply(
            { line: at("Built weekly"), text: "Built weekly Tableau dashboards used by 40 managers.", requirements: ["I1"], support: [{ id: p1, quote: "used by 40 managers" }] },
            { line: at("Cleaned"), text: "Led SQL cleaning of survey data for 1,250 households.", requirements: ["I2"], support: [{ id: p2, quote: "using SQL" }] },
            { line: at("Organized"), action: "trim", reason: "Unrelated to the role." },
            { line: at("SQL, Excel"), text: "SQL, Excel, Tableau, team of 12", support: [{ id: posting.passages[0].id, quote: "team of 12" }] },
          ),
          usage: USAGE,
        };
      }
      // The truth check: the first rewrite matches, the second says more ("Led").
      return {
        data: {
          items: [
            { id: "L1", status: "in_master", evidence: [{ id: p1, quote: "used by 40 managers" }], linked_targets: [], rationale: "Stated." },
            { id: "L2", status: "overstated", evidence: [{ id: p2, quote: "Cleaned survey data" }], linked_targets: [], rationale: "The master does not say she led it." },
          ],
        },
        usage: USAGE,
      };
    });
    const out = (await tailorLinesHandler(inputs, tailorNode(), ctx)) as Out;

    // Prompts: the stable system prompt; lines by ref with their section; the posting left out; gaps marked.
    const [tailorCall, traceCall] = claudeJson.mock.calls.map((c) => c[0]);
    expect(tailorCall).toMatchObject({ task: "workflow.tailor", system: TAILOR_SYSTEM, agent: AGENT });
    expect(tailorCall.system).toContain(MATERIAL_LINE);
    expect(tailorCall.user).toContain(`[${at("Built weekly")}] (Experience) Built weekly sales dashboards.`);
    expect(tailorCall.user).not.toContain("Jane Doe");
    expect(tailorCall.user).not.toContain("Lead a team of 12");
    expect(tailorCall.user).toContain("GAP: no evidence in the master; do not write a line for it");
    expect(tailorCall.user).toContain("at most 25 line changes");
    expect(traceCall.task).toBe("workflow.trace");
    expect(traceCall.user).toContain(TAILOR_TRUTH.question);
    expect(traceCall.user).not.toContain("Lead a team of 12");
    // Only the two rewrites are truth-checked (not the trim, nor the line dropped in code).
    expect(traceCall.user.match(/<item id=/g)).toHaveLength(2);

    const op = out.op as Extract<DocumentChangeOp, { op: "replace_lines" }>;
    expect(op.op).toBe("replace_lines");
    expect(op.lines.map((l) => [l.id, l.action, l.original])).toEqual([
      ["L1", "rewrite", "Built weekly sales dashboards."],
      ["L2", "trim", "Organized the office party."],
    ]);
    expect(op.lines[0].evidence).toEqual([expect.objectContaining({ ref: p1, verified: true })]);
    expect(out.lines).toEqual(op.lines);

    const findings = out.findings as Finding[];
    expect(findings[0]).toMatchObject({ kind: "tailor_summary", severity: "info", title: "Proposed 2 line changes; 1 dropped by the truth check, 1 by the code checks" });
    const dropped = findings.filter((f) => f.kind === "tailor_line_dropped");
    expect(dropped.map((f) => [f.severity, f.status, f.title])).toEqual([
      ["minor", "dropped", "Dropped: “SQL, Excel, Tableau, team of 12”"],
      ["minor", "overstated", "Dropped: “Led SQL cleaning of survey data for 1,250 households.”"],
    ]);
    expect(dropped[1]).toMatchObject({ detail: "Says more than the master: The master does not say she led it.", location: { sectionId: "e1", specKey: "experience", heading: "Experience", quote: "Cleaned survey data for 1,250 households." } });
    expect(dropped[1].evidence).toEqual([expect.objectContaining({ ref: p2 })]);
    expect(findings.every((f) => f.severity !== "blocking")).toBe(true);

    const table = out.table as OutcomeTable;
    expect(table).toMatchObject({ key: "tailor", title: "Proposed lines" });
    expect(table.rows.map((r) => [r.cells.action, r.cells.requirements])).toEqual([
      ["Rewrite", "Tableau dashboards"],
      ["Trim", ""],
    ]);
    expect(table.rows[0].evidence).toHaveLength(1);
  });

  it("skips the truth call when no line has new text, and proposes nothing when every line fails", async () => {
    const { ctx, inputs } = await resume();
    const lines = documentLines((await ctx.document()).content_json);
    claudeJson.mockResolvedValueOnce({ data: reply({ line: lines.find((l) => l.text.startsWith("Organized"))!.ref, action: "trim" }), usage: USAGE });
    const trimmed = (await tailorLinesHandler(inputs, tailorNode(), ctx)) as Out;
    expect(claudeJson).toHaveBeenCalledTimes(1);
    expect((trimmed.op as { lines: ReplaceLine[] }).lines).toHaveLength(1);

    claudeJson.mockReset();
    claudeJson.mockResolvedValueOnce({ data: reply({ line: "D42", text: "Made up." }), usage: USAGE });
    const out = (await tailorLinesHandler(inputs, tailorNode(), ctx)) as Out;
    expect(out.op).toBeNull();
    expect((out.findings as Finding[])[0].title).toBe("No line changes proposed; 1 dropped by the code checks");
  });

  it("fails the step when the truth check fails, so unchecked lines are never proposed", async () => {
    const { ctx, inputs, master } = await resume();
    const lines = documentLines((await ctx.document()).content_json);
    claudeJson.mockImplementation(async (c: { task: string }) => {
      if (c.task === "workflow.trace") throw new Error("model unavailable");
      return { data: reply({ line: lines.find((l) => l.text.startsWith("Built"))!.ref, text: "Built Tableau dashboards for 40 managers.", support: [{ id: master.passages[0].id, quote: "used by 40 managers" }] }), usage: USAGE };
    });
    await expect(tailorLinesHandler(inputs, tailorNode(), ctx)).rejects.toThrow("model unavailable");
  });

  it("drops a line the truth check passes with only an empty quote: that is no checkable support", async () => {
    const { ctx, inputs, master } = await resume();
    const lines = documentLines((await ctx.document()).content_json);
    claudeJson.mockImplementation(async (c: { task: string }) =>
      c.task === "workflow.trace"
        ? { data: { items: [{ id: "L1", status: "in_master", evidence: [{ id: master.passages[0].id, quote: "" }], linked_targets: [], rationale: "Stated." }] }, usage: USAGE }
        : { data: reply({ line: lines.find((l) => l.text.startsWith("Built"))!.ref, text: "Built Tableau dashboards for 40 managers.", support: [{ id: master.passages[0].id, quote: "used by 40 managers" }] }), usage: USAGE },
    );
    const out = (await tailorLinesHandler(inputs, tailorNode(), ctx)) as Out;
    expect(out.op).toBeNull();
    expect((out.findings as Finding[]).find((f) => f.kind === "tailor_line_dropped")).toMatchObject({ status: "overstated", detail: expect.stringContaining("No checkable support was cited.") });
  });
});
