// One case per model task the step nodes use, shared by the live tests
// (steps.live.test.ts calls the real model and can record the reply) and the
// recorded-fixture contract tests (recorded.test.ts replays each recording
// through the node's own parse and check path). A case holds its material as
// plain JSON so a recording carries everything its replay needs. Test support
// only.

import { expect } from "vitest";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { fileTypeByKey } from "@/catalog/files";
import type { ExtractedItem, Finding } from "../contract";
import type { CriterionSpec, GateInput, ReviewConfig, ReviewerSpec } from "../node-specs/steps";
import { CHECK_SYSTEM, COVERAGE_SYSTEM, DECIDE_SYSTEM, EXTRACT_SYSTEM, GATE_SYSTEM, RUBRIC_SYSTEM, TRACE_SYSTEM, WEB_SYSTEM } from "./prompts";
import { buildResults, checkSchema, checkUserPrompt, type CheckConfig, type CheckReply } from "./check";
import { buildCoverage, coverageNeeds, CoverageModelOutput, coverageUserPrompt } from "./coverage";
import { buildDecision, decideSchema, decideUserPrompt, type DecideConfig, type DecideReply } from "./decide";
import { buildItems, extractSchema, extractUserPrompt, type ExtractConfig, type ExtractReply } from "./extract";
import { applyGateReply, GateModelOutput, gateUserPrompt, keywordGate, type GateMaterial } from "./gate";
import { snapshotDocument } from "./readers";
import { buildReview, ReviewModelOutput, reviewSystem, reviewUserPrompt } from "./review";
import { buildScores, rubricCriteria, RubricModelOutput, rubricUserPrompt } from "./rubric";
import { heading, para } from "@/lib/sections/test-fixtures";
import { applyTrace, traceSchema, traceUserPrompt, type TraceConfig, type TraceMaterial, type TraceReply } from "./trace";
import type { DocSnapshot, SourcesSnapshot } from "./types";
import { EvidenceIndex } from "./util";
import { filterResources, searchTool, WebModelOutput, webQuery, type WebQuery } from "./web-find";
import type { z } from "zod";

export type LiveCase = {
  task: "web.find" | "workflow.gate" | "workflow.extract" | "workflow.trace" | "workflow.review" | "workflow.check" | "workflow.decide" | "coverage.score" | "rubric.check";
  /** Everything the prompts and the replay need (stored in the recording). */
  material: Record<string, unknown>;
  /** The calls to make: one, or one per reviewer. */
  calls(material: Record<string, unknown>): Array<{ system: string; user: string; schema: z.ZodType; tools?: BetaToolUnion[] }>;
  /** The node's parse and check path over the replies, with the contract's assertions. */
  verify(material: Record<string, unknown>, replies: unknown[], searchedUrls?: string[]): void;
};

const SRC_A = "5b1e2c4a-0d1f-4a8e-9a77-0c2b8f1d3e01";
const SRC_B = "8f3a9d2e-6c4b-4e1a-b5d0-2a7c9e8f1b02";

const fie = (content: ReturnType<typeof para>[]): DocSnapshot =>
  snapshotDocument({ id: "doc-live", title: "Evaluation report", type_key: "fie", updated_at: "2026-10-08T00:00:00.000Z", content_json: { type: "doc", content }, content_text: "" }, fileTypeByKey("fie"), 8000);

const proposal = (content: ReturnType<typeof para>[]): DocSnapshot =>
  snapshotDocument({ id: "doc-live", title: "Riverside path restoration", type_key: "proposal", updated_at: "2026-10-08T00:00:00.000Z", content_json: { type: "doc", content }, content_text: "" }, fileTypeByKey("proposal"), 8000);

const FIE_DOC = fie([
  heading("Reason for Referral", "rfr", "reason_for_referral"),
  para("Ms. Ortiz, the third-grade teacher, referred the student in September because of slow, effortful reading and difficulty decoding multisyllabic words despite twelve weeks of Tier 2 intervention."),
  heading("Academic Functioning", "acad", "academic_functioning"),
  para("On the WIAT-4, administered on 2026-09-22, the Reading Composite standard score was 78 and the Math Composite standard score was 101. Oral Reading Fluency was 74."),
  para("Classroom observation on 2026-09-25 showed the student avoiding independent reading tasks."),
  heading("Eligibility Determination", "elig", "eligibility_determination"),
  para("The student meets criteria for a specific learning disability in basic reading skills and reading fluency."),
]);

const FIE_SOURCES: SourcesSnapshot = {
  sources: [
    { id: SRC_A, title: "Parent permission packet", kind: "file", role: null, summary: "The parent signed the Notice and Consent for Initial Evaluation on 2026-09-08, permitting testing in all areas of suspected disability.", status: "ready", url: null },
    { id: SRC_B, title: "WIAT-4 score report", kind: "file", role: null, summary: "Score report for the WIAT-4 given on 2026-09-22.", status: "ready", url: null },
  ],
  passages: [
    { id: "S5b1e2c4a.P1", sourceId: SRC_A, page: 1, text: "Notice and Consent for Initial Evaluation. Parent signature dated September 8, 2026." },
    { id: "S8f3a9d2e.P1", sourceId: SRC_B, page: 1, text: "Reading Composite: 78 (Low). Math Composite: 101 (Average). Oral Reading Fluency: 74 (Low)." },
    { id: "S8f3a9d2e.P2", sourceId: SRC_B, page: 2, text: "Test date: 09/22/2026. Examiner: J. Patel, LSSP." },
  ],
};

const PROPOSAL_DOC = proposal([
  heading("Summary", "sum", "summary"),
  para("We request £40,000 to rebuild 400 metres of the riverside path by September 2027."),
  heading("Budget", "bud", "budget"),
  para("Bank works £38,400 (contractor quote). Signage £1,600. Total £40,000."),
  heading("Timeline", "tl", "timeline"),
  para("Work starts in March 2027 and the path reopens in September 2027."),
]);

const PROPOSAL_SOURCES: SourcesSnapshot = {
  sources: [{ id: SRC_A, title: "Greenbank contractor quote", kind: "file", role: null, summary: "A quote for rebuilding 400 m of riverside path and stabilizing the bank: £38,400 including VAT, valid for 90 days.", status: "ready", url: null }],
  passages: [{ id: "S5b1e2c4a.P1", sourceId: SRC_A, page: 1, text: "Rebuild 400 m of footpath and stabilize the riverbank. Total price £38,400 including VAT. Valid for 90 days." }],
};

const asMaterial = (o: object) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

// --- web.find -----------------------------------------------------------------------

const webCase: LiveCase = {
  task: "web.find",
  material: asMaterial({
    query: webQuery(
      { sensitive: true, webDomains: ["law.cornell.edu", "tea.texas.gov", "ed.gov", "sites.ed.gov"] },
      fileTypeByKey("fie"),
      null,
      coverageNeeds(fileTypeByKey("fie")!, false)
        .filter((n) => /consent|test protocols/i.test(n.need))
        .map((n) => ({ need: n.need, specKey: n.specKey, heading: n.heading })),
      { maxResults: 4, maxSearches: 3, allowedDomains: [], blockedDomains: [] },
    ),
    maxSearches: 3,
  }),
  calls: (m) => [{ system: WEB_SYSTEM, user: (m.query as WebQuery).user, schema: WebModelOutput, tools: [searchTool(m.query as WebQuery, m.maxSearches as number)] }],
  verify(m, [reply], searchedUrls = []) {
    const data = WebModelOutput.parse(reply);
    const q = m.query as WebQuery;
    const kept = filterResources(data, searchedUrls, q, 10);
    for (const r of kept) {
      expect(searchedUrls.length).toBeGreaterThan(0);
      expect(r.verified).toBe(false);
      expect(q.allowed.some((d) => new URL(r.url).hostname.replace(/^www\./, "").endsWith(d))).toBe(true);
      expect(q.gaps.map((g) => g.need)).toContain(r.need);
    }
  },
};

// --- workflow.gate --------------------------------------------------------------------

const GATE_INPUTS: GateInput[] = [
  { key: "consent", label: "Written consent for evaluation", kind: "any", match: ["written consent for evaluation"], specKeys: [], required: true, help: "The signed parental consent for the evaluation." },
  { key: "hearing", label: "Hearing screening", kind: "any", match: ["audiometric screening"], specKeys: [], required: true, help: "A hearing screening result from the nurse." },
];

const gateCase: LiveCase = {
  task: "workflow.gate",
  material: asMaterial({ m: { doc: FIE_DOC, sources: FIE_SOURCES.sources, tables: [], notes: null }, inputs: GATE_INPUTS }),
  calls(material) {
    const m = material.m as GateMaterial;
    const inputs = material.inputs as GateInput[];
    const items = keywordGate(inputs, m);
    return [{ system: GATE_SYSTEM, user: gateUserPrompt(inputs.filter((_, i) => !items[i].present), m), schema: GateModelOutput }];
  },
  verify(material, [reply]) {
    const m = material.m as GateMaterial;
    const data = GateModelOutput.parse(reply);
    const items = applyGateReply(keywordGate(material.inputs as GateInput[], m), data, new EvidenceIndex({ doc: m.doc, sources: { sources: m.sources, passages: [] } }));
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    // Consent is in a source summary in other words; nothing mentions hearing.
    expect(byKey.consent).toMatchObject({ present: true, how: "model" });
    expect(byKey.consent.evidence.some((e) => e.ref === SRC_A)).toBe(true);
    expect(byKey.hearing.present).toBe(false);
  },
};

// --- workflow.extract --------------------------------------------------------------------

const EXTRACT_CONFIG: ExtractConfig = {
  item: "evidence",
  fields: [
    { name: "instrument", label: "Instrument", type: "text", description: "The test, observation or record", required: true },
    { name: "measure", label: "Measure", type: "text", description: "The composite, subtest or behaviour", required: false },
    { name: "score", label: "Score", type: "number", description: "The standard score, if any", required: false },
    { name: "date", label: "Date", type: "date", description: "When it was given", required: false },
    { name: "area", label: "Area", type: "enum", values: ["reading", "math", "behavior", "other"], description: "The area it informs", required: false },
  ],
  instructions: "One item per score or observation.",
  from: ["document", "sources"],
  sectionKeys: [],
  sourceMatch: [],
  maxItems: 20,
};

const extractCase: LiveCase = {
  task: "workflow.extract",
  material: asMaterial({ doc: FIE_DOC, sources: FIE_SOURCES, config: EXTRACT_CONFIG }),
  calls: (m) => [{ system: EXTRACT_SYSTEM, user: extractUserPrompt(m.config as ExtractConfig, { doc: m.doc as DocSnapshot, sources: m.sources as SourcesSnapshot, tables: [], notes: null }), schema: extractSchema((m.config as ExtractConfig).fields) }],
  verify(m, [reply]) {
    const config = m.config as ExtractConfig;
    const data = extractSchema(config.fields).parse(reply) as ExtractReply;
    const items = buildItems(data, config, new EvidenceIndex({ doc: m.doc as DocSnapshot, sources: m.sources as SourcesSnapshot }));
    expect(items.length).toBeGreaterThanOrEqual(3);
    const reading = items.find((i) => i.fields.score === 78);
    expect(reading?.fields.area).toBe("reading");
    expect(items.some((i) => i.fields.score === 101)).toBe(true);
    // Most location quotes are copied word for word.
    const docLinks = items.flatMap((i) => i.evidence.filter((e) => e.kind === "document"));
    expect(docLinks.filter((e) => e.verified).length).toBeGreaterThanOrEqual(Math.ceil(docLinks.length / 2));
  },
};

// --- workflow.trace ---------------------------------------------------------------------

const TRACE_ITEMS: ExtractedItem[] = [
  { id: "I1", fields: { claim: "The Reading Composite standard score was 78." }, location: null, evidence: [] },
  { id: "I2", fields: { claim: "The student's IQ is 112." }, location: null, evidence: [] },
];
const TRACE_CONFIG = (): TraceConfig => ({
  against: "sources",
  statuses: [
    { key: "supported", label: "Supported", ok: true, severity: "info" },
    { key: "unsupported", label: "Unsupported", ok: false, severity: "major" },
    { key: "contradicted", label: "Contradicted", ok: false, severity: "major" },
  ],
  unverifiedStatus: "unsupported",
  question: "Does a source passage establish the claim as stated?",
  bothWays: false,
  instructions: "",
});

const traceCase: LiveCase = {
  task: "workflow.trace",
  material: asMaterial({ m: { items: TRACE_ITEMS, targets: [], sources: FIE_SOURCES, doc: null, tables: [] }, config: TRACE_CONFIG() }),
  calls: (m) => [{ system: TRACE_SYSTEM, user: traceUserPrompt(m.config as TraceConfig, m.m as TraceMaterial), schema: traceSchema((m.config as TraceConfig).statuses) }],
  verify(material, [reply]) {
    const config = material.config as TraceConfig;
    const m = material.m as TraceMaterial;
    const data = traceSchema(config.statuses).parse(reply) as TraceReply;
    const traced = applyTrace(data, config, m, new EvidenceIndex({ sources: m.sources }));
    expect(traced.map((t) => t.status)).toEqual(["supported", "unsupported"]);
    expect(traced[0].evidence.some((e) => e.kind === "passage" && e.ref === "S8f3a9d2e.P1" && e.sourceId === SRC_B)).toBe(true);
  },
};

// --- workflow.review --------------------------------------------------------------------

const REVIEWERS: ReviewerSpec[] = [
  { key: "advocate", label: "Advocate", brief: "Build the strongest case that each criterion is met, citing the evidence for it." },
  { key: "skeptic", label: "Skeptic", brief: "Seek evidence against each criterion, missing data, and reliance on a single measure." },
];
const REVIEW_CRITERIA: CriterionSpec[] = [
  { key: "sld_reading", label: "Specific learning disability in basic reading skills", guidance: "Low achievement in basic reading with data showing appropriate instruction and a classroom observation.", scale: { kind: "enum", values: ["met", "not_met", "insufficient_evidence"] } },
  { key: "sld_math", label: "Specific learning disability in math calculation", guidance: "Low achievement in math calculation.", scale: { kind: "enum", values: ["met", "not_met", "insufficient_evidence"] } },
];
const REVIEW_CONFIG = { reviewers: REVIEWERS, criteria: REVIEW_CRITERIA, criteriaFrom: null, matrix: false, instructions: "", strengthsAndWeaknesses: true } as ReviewConfig;

const reviewCase: LiveCase = {
  task: "workflow.review",
  material: asMaterial({ doc: FIE_DOC, sources: FIE_SOURCES }),
  calls: (m) => {
    const user = reviewUserPrompt(REVIEW_CONFIG, REVIEW_CRITERIA, { doc: m.doc as DocSnapshot, sources: m.sources as SourcesSnapshot, items: [], requirements: null });
    return REVIEWERS.map((r) => ({ system: reviewSystem(r), user, schema: ReviewModelOutput }));
  },
  verify(m, replies) {
    const index = new EvidenceIndex({ doc: m.doc as DocSnapshot, sources: m.sources as SourcesSnapshot });
    const reviews = replies.map((reply, i) => buildReview(REVIEWERS[i], ReviewModelOutput.parse(reply), REVIEW_CRITERIA, index, 1));
    for (const r of reviews) {
      // Math 101 is average: no reviewer finds a math disability.
      expect(r.ratings.find((x) => x.item === "sld_math")?.verdict).not.toBe("met");
      expect(r.ratings.length).toBeGreaterThanOrEqual(1);
      expect(r.ratings.some((x) => x.evidence.length > 0)).toBe(true);
    }
  },
};

// --- workflow.check ---------------------------------------------------------------------

const CHECK_CONFIG: CheckConfig = {
  checklist: [
    { key: "variety_of_sources", label: "A variety of sources", question: "Does the evaluation draw on more than one kind of source (tests, observation, records, interviews)?", severity: "major", appliesTo: [] },
    { key: "potential_wording", label: "Potential, not final", question: "Is the eligibility conclusion worded as a potential determination for the ARD committee rather than a final decision?", severity: "major", appliesTo: [] },
  ],
  statuses: [
    { key: "met", label: "Met", ok: true, severity: "info" },
    { key: "partly_met", label: "Partly met", ok: false, severity: "minor" },
    { key: "not_met", label: "Not met", ok: false, severity: "major" },
  ],
  perItem: false,
  instructions: "",
};

const checkCase: LiveCase = {
  task: "workflow.check",
  material: asMaterial({ doc: FIE_DOC }),
  calls: (m) => [{ system: CHECK_SYSTEM, user: checkUserPrompt(CHECK_CONFIG, { doc: m.doc as DocSnapshot, sources: null, items: [], requirements: null, tables: [] }), schema: checkSchema(CHECK_CONFIG) }],
  verify(m, [reply]) {
    const data = checkSchema(CHECK_CONFIG).parse(reply) as CheckReply;
    const doc = m.doc as DocSnapshot;
    const results = buildResults(data, CHECK_CONFIG, { doc, sources: null, items: [], requirements: null, tables: [] }, new EvidenceIndex({ doc }));
    expect(results.map((r) => r.check)).toEqual(["variety_of_sources", "potential_wording"]);
    // "The student meets criteria" reads as final.
    expect(results[1].status).not.toBe("met");
    expect(results.every((r) => r.status !== "not_assessed")).toBe(true);
  },
};

// --- workflow.decide --------------------------------------------------------------------

const finding = (id: string, severity: Finding["severity"], title: string): Finding => ({ id, nodeId: id.split(":")[0], kind: "check", severity, status: null, title, detail: "", location: null, evidence: [], reviewer: null, verified: true, fix: "" });
const DECIDE_CONFIG: DecideConfig = { values: ["ready", "ready_after_fixes", "not_ready"], guidance: "not_ready when any finding is blocking; ready_after_fixes when any is major; otherwise ready." };

const decideCase: LiveCase = {
  task: "workflow.decide",
  material: asMaterial({ findings: [finding("scope:1", "major", "The pricing omits the signage promised in the summary"), finding("terms:1", "minor", "No validity period")] }),
  calls: (m) => [{ system: DECIDE_SYSTEM, user: decideUserPrompt(DECIDE_CONFIG, { findings: m.findings as Finding[], agreed: [], disagreements: [], results: [], scores: [] }), schema: decideSchema(DECIDE_CONFIG.values) }],
  verify(m, [reply]) {
    const data = decideSchema(DECIDE_CONFIG.values).parse(reply) as DecideReply;
    const out = buildDecision(data, DECIDE_CONFIG, { findings: m.findings as Finding[], agreed: [], disagreements: [], results: [], scores: [] });
    expect(out.value).toBe("ready_after_fixes");
    expect(out.rationale).toContain("scope:1");
  },
};

// --- coverage.score ---------------------------------------------------------------------

const coverageCase: LiveCase = {
  task: "coverage.score",
  material: asMaterial({ doc: PROPOSAL_DOC, sources: PROPOSAL_SOURCES, needs: coverageNeeds(fileTypeByKey("proposal")!, false) }),
  calls: (m) => [{ system: COVERAGE_SYSTEM, user: coverageUserPrompt(m.needs as ReturnType<typeof coverageNeeds>, { doc: m.doc as DocSnapshot, sources: m.sources as SourcesSnapshot, tables: [] }), schema: CoverageModelOutput }],
  verify(m, [reply]) {
    const needs = m.needs as ReturnType<typeof coverageNeeds>;
    const rows = buildCoverage(CoverageModelOutput.parse(reply), needs, new EvidenceIndex({ doc: m.doc as DocSnapshot, sources: m.sources as SourcesSnapshot }));
    expect(rows).toHaveLength(needs.length);
    const quote = rows.find((r) => r.need === "Quotes or cost estimates")!;
    expect(quote.status).not.toBe("missing");
    expect(quote.evidence.some((e) => e.sourceId === SRC_A)).toBe(true);
    expect(rows.find((r) => r.need === "Evidence of the problem or opportunity")!.status).not.toBe("supported");
  },
};

// --- rubric.check -----------------------------------------------------------------------

const rubricCase: LiveCase = {
  task: "rubric.check",
  material: asMaterial({ doc: PROPOSAL_DOC }),
  calls: (m) => {
    const d = m.doc as DocSnapshot;
    return [{ system: RUBRIC_SYSTEM, user: rubricUserPrompt(d, rubricCriteria(d, []), null), schema: RubricModelOutput }];
  },
  verify(m, [reply]) {
    const d = m.doc as DocSnapshot;
    const criteria = rubricCriteria(d, []);
    const scores = buildScores(RubricModelOutput.parse(reply), criteria, new EvidenceIndex({ doc: d }));
    expect(scores.length).toBeGreaterThanOrEqual(Math.ceil(criteria.length / 2));
    for (const s of scores) {
      expect(s.level).toBeGreaterThanOrEqual(1);
      expect(s.level).toBeLessThanOrEqual(s.maxLevel);
    }
    expect(scores.some((s) => s.evidence.some((e) => e.kind === "document" && e.verified))).toBe(true);
  },
};

export const LIVE_CASES: LiveCase[] = [webCase, gateCase, extractCase, traceCase, reviewCase, checkCase, decideCase, coverageCase, rubricCase];

/** A recording: the material it ran on and every reply, so the replay needs nothing else. */
export type Recording = { task: LiveCase["task"]; recorded_at: string; model: string; material: Record<string, unknown>; replies: unknown[]; searched_urls?: string[] };

export const fixtureName = (task: string) => `${task}.recorded.json`;

