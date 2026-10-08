import { beforeEach, describe, expect, it, vi } from "vitest";

const { claudeJson } = vi.hoisted(() => ({ claudeJson: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson }));

import type { Disagreement, ExtractedItem, Review } from "../contract";
import { agree, agreeTable, latestRatings, NOT_RATED } from "./agree";
import { snapshotDocument } from "./readers";
import { buildReview, criteriaFromSet, matrixCriteria, reviewFindings, stepReview } from "./review";
import { ctxFor, heading, makeDocument, nodeOf, para, resetStores, USAGE } from "./test-fixtures";
import { EvidenceIndex } from "./util";

beforeEach(() => {
  resetStores();
  claudeJson.mockReset();
});

const D = snapshotDocument(
  { id: "d", title: "Plan", type_key: null, updated_at: "2026-10-08T00:00:00.000Z", content_json: { type: "doc", content: [heading("Aims", "aims", "aims"), para("Aim 1 tests whether the drug lowers blood pressure.")] }, content_text: "" },
  null,
  8000,
);

const reviewers = [
  { key: "primary", label: "Primary", brief: "BRIEF-PRIMARY: write the assigned reviewer's critique of each factor." },
  { key: "skeptic", label: "Skeptic", brief: "BRIEF-SKEPTIC: find the weaknesses most likely to drive the score." },
  { key: "outsider", label: "Outsider", brief: "BRIEF-OUTSIDER: judge importance to the broader field and clarity." },
];
const criteria = [
  { key: "factor_1", label: "Importance", guidance: "", scale: { kind: "score", min: 1, max: 9, best: "low" } },
  { key: "factor_3", label: "Expertise", guidance: "", scale: { kind: "enum", values: ["sufficient", "gaps_identified", "not_rated"] } },
];

const reply = (who: string, score: number) => ({
  data: {
    ratings: [
      { item: "factor_1", verdict: null, score, rationale: `${who}-RATIONALE`, evidence: [{ id: "aims", quote: "Aim 1 tests" }] },
      { item: "factor_3", verdict: "not_rated", score: null, rationale: "No biosketches.", evidence: [] },
      { item: "made_up", verdict: "x", score: null, rationale: "", evidence: [] },
    ],
    strengths: [],
    weaknesses: [{ text: `${who}-WEAKNESS`, evidence: [{ id: "nope", quote: "" }] }],
  },
  usage: USAGE,
});

const briefOf = (system: string) => reviewers.filter((r) => system.includes(r.brief.split(":")[0])).map((r) => r.key);

describe("step.review", () => {
  it("calls each reviewer once in parallel with only its own brief and the same material", async () => {
    const { doc } = await makeDocument({});
    claudeJson.mockImplementation(async (input: { system: string }) => reply(briefOf(input.system)[0], 3));
    const out = (await stepReview({ document: D }, nodeOf("step.review", { reviewers, criteria }), ctxFor(doc.id))) as { reviews: Review[]; findings: Array<{ reviewer: string; kind: string; severity: string }> };
    expect(claudeJson).toHaveBeenCalledTimes(3);
    const calls = claudeJson.mock.calls.map((c) => c[0] as { system: string; user: string; task: string });
    for (const [i, c] of calls.entries()) {
      expect(c.task).toBe("workflow.review");
      const prompt = `${c.system}\n${c.user}`;
      expect(briefOf(prompt)).toEqual([reviewers[i].key]);
      expect(prompt).toContain("You have not seen the others' work.");
      // No reviewer's output reaches another.
      expect(prompt).not.toMatch(/-RATIONALE|-WEAKNESS/);
    }
    expect(new Set(calls.map((c) => c.user)).size).toBe(1);
    expect(out.reviews.map((r) => [r.reviewer, r.round, r.ratings.map((x) => x.item)])).toEqual([
      ["primary", 1, ["factor_1", "factor_3"]],
      ["skeptic", 1, ["factor_1", "factor_3"]],
      ["outsider", 1, ["factor_1", "factor_3"]],
    ]);
    expect(out.reviews[0].ratings[0].evidence[0]).toMatchObject({ kind: "document", ref: "aims", verified: true });
    expect(out.findings.map((f) => [f.reviewer, f.kind, f.severity])).toEqual([
      ["primary", "weakness", "major"],
      ["skeptic", "weakness", "major"],
      ["outsider", "weakness", "major"],
    ]);
  });

  it("discuss: round 2 shows the other reviewers' positions on the disputed items only, and rescores just those", async () => {
    const { doc } = await makeDocument({});
    const pos = (reviewer: string, score: number | null, verdict: string | null, rationale: string) => ({ reviewer, label: reviewer, brief: `brief of ${reviewer}`, score, verdict, rationale, evidence: [] });
    const disputes: Disagreement[] = [{ id: "agree1:d1", nodeId: "agree1", item: "factor_1", label: "Factor 1", blocking: false, positions: [pos("primary", 2, null, "PRIMARY-SAYS"), pos("skeptic", 6, null, "SKEPTIC-SAYS"), pos("outsider", 4, null, "OUTSIDER-SAYS")] }];
    claudeJson.mockResolvedValue({ data: { ratings: [{ item: "factor_1", verdict: null, score: 4, rationale: "Moved.", evidence: [] }, { item: "factor_3", verdict: "not_rated", score: null, rationale: "", evidence: [] }], strengths: [{ text: "s", evidence: [] }], weaknesses: [{ text: "w", evidence: [] }] }, usage: USAGE });
    const out = (await stepReview({ document: D, discuss: [disputes] }, nodeOf("step.review", { reviewers, criteria }), ctxFor(doc.id))) as { reviews: Review[]; findings: unknown[] };
    const calls = claudeJson.mock.calls.map((c) => c[0] as { system: string; user: string });
    const skeptic = calls[1].user;
    expect(skeptic).toContain("Change your score only if their evidence warrants it");
    expect(skeptic).toContain("PRIMARY-SAYS");
    expect(skeptic).toContain("OUTSIDER-SAYS");
    expect(skeptic).not.toContain("SKEPTIC-SAYS");
    expect(skeptic).toContain("- factor_1:");
    expect(skeptic).not.toContain("- factor_3:");
    // Positions never carry the other reviewers' briefs.
    expect(skeptic).not.toContain("brief of primary");
    expect(out.reviews.every((r) => r.round === 2)).toBe(true);
    expect(out.reviews[0].ratings.map((r) => r.item)).toEqual(["factor_1"]);
    expect(out.reviews[0].weaknesses).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it("an empty discuss list makes no calls", async () => {
    const { doc } = await makeDocument({});
    const out = await stepReview({ document: D, discuss: [] }, nodeOf("step.review", { reviewers, criteria }), ctxFor(doc.id));
    expect(out).toEqual({ reviews: [], findings: [] });
    expect(claudeJson).not.toHaveBeenCalled();
  });

  it("a wired discuss input that delivered nothing (its branch not taken) makes no calls, rather than a fresh round-1 review", async () => {
    const { doc } = await makeDocument({});
    const ctx = ctxFor(doc.id);
    ctx.run.graph = { format: "graph-v1", nodes: [], edges: [{ id: "e", source: "split", sourceHandle: "false", target: "disc", targetHandle: "discuss" }] };
    const out = await stepReview({ document: D }, nodeOf("step.review", { reviewers, criteria }, "disc"), ctx);
    expect(out).toEqual({ reviews: [], findings: [] });
    expect(claudeJson).not.toHaveBeenCalled();
  });

  it("builds matrix cells from option and criterion items", () => {
    const it_ = (id: string, kind: string, name: string): ExtractedItem => ({ id, fields: { kind, id: name.toLowerCase().replace(/ /g, "_"), name, description: `${name} described`, is_status_quo: false }, location: null, evidence: [] });
    const cells = matrixCriteria([it_("I1", "option", "Status quo"), it_("I2", "option", "New levy"), it_("I3", "criterion", "Cost"), it_("I4", "criterion", "Equity")]);
    expect(cells.map((c) => c.key)).toEqual(["status_quo__cost", "status_quo__equity", "new_levy__cost", "new_levy__equity"]);
    expect(cells[0]).toMatchObject({ label: "Status quo × Cost", scale: { kind: "enum", values: ["strong", "adequate", "weak", "unknown"] } });
    expect(() => criteriaFromSet("no-such-set")).toThrow(/unknown requirement set/);
  });

  it("drops off-scale ratings (pure)", () => {
    const r = buildReview(reviewers[0], { ratings: [{ item: "factor_1", verdict: null, score: 12, rationale: "", evidence: [] }, { item: "factor_3", verdict: "great", score: null, rationale: "", evidence: [] }], strengths: [], weaknesses: [] }, criteria as never, new EvidenceIndex({ doc: D }), 1);
    expect(r.ratings).toEqual([]);
  });
});

const rv = (reviewer: string, round: 1 | 2, ratings: Array<[string, string | null, number | null]>): Review => ({
  reviewer,
  label: reviewer.toUpperCase(),
  brief: `${reviewer} brief`,
  round,
  strengths: [],
  weaknesses: [],
  ratings: ratings.map(([item, verdict, score]) => ({ item, verdict, score, rationale: `${reviewer} on ${item}`, evidence: [] })),
});

describe("reviewFindings", () => {
  const ev = (ref: string) => ({ kind: "document" as const, ref, quote: "", verified: true, stance: "for" as const });
  const review = (reviewer: string, weaknesses: Array<[string, string[]]>): Review => ({ reviewer, label: `${reviewer} reviewer`, brief: "", round: 1, ratings: [], strengths: [], weaknesses: weaknesses.map(([text, refs]) => ({ text, evidence: refs.map(ev) as never })) });

  it("takes each reviewer's weaknesses round-robin, ranks a point several reviewers raised first, and moves the repeats to the end", () => {
    const out = reviewFindings("rev", [
      review("primary", [["P1", ["a"]], ["P2", ["b"]], ["P3", []]]),
      review("skeptic", [["S1", ["c"]], ["S2 (same as P2)", ["b"]]]),
      review("outsider", [["O1 (same as P2)", ["b"]]]),
    ]);
    // O1 is the outsider's first point and P2 and S2 make it again (same passage): it leads, and they go last.
    expect(out.map((f) => f.title)).toEqual(["O1 (same as P2)", "P1", "S1", "P3", "P2", "S2 (same as P2)"]);
    expect(out[0].detail).toBe("O1 (same as P2)\n\nAlso raised by: primary reviewer, skeptic reviewer.");
    expect(out.map((f) => f.id)).toEqual(["rev:1", "rev:2", "rev:3", "rev:4", "rev:5", "rev:6"]);
  });
});

describe("step.agree (pure)", () => {
  const verdict = { mode: "verdict" as const, tolerance: 2, blockingVerdicts: [], meanTimes10: false };

  it("verdict mode: equal verdicts agree; different ones disagree and keep every position", () => {
    const r = agree("agree", [rv("a", 1, [["c1", "met", null], ["c2", "met", null]]), rv("b", 1, [["c1", "met", null], ["c2", "not_met", null]])], verdict);
    expect(r.agreed.map((a) => [a.item, a.verdict])).toEqual([["c1", "met"]]);
    expect(r.disagreements).toHaveLength(1);
    const d = r.disagreements[0];
    expect(d).toMatchObject({ id: "agree:d1", nodeId: "agree", item: "c2", blocking: false });
    expect(d.positions.map((p) => [p.reviewer, p.verdict, p.rationale, p.brief])).toEqual([
      ["a", "met", "a on c2", "a brief"],
      ["b", "not_met", "b on c2", "b brief"],
    ]);
    expect(r.findings.map((f) => [f.id, f.kind, f.severity])).toEqual([["agree:1", "reviewer_disagreement", "major"]]);
  });

  it("an item only some reviewers rated is not agreed: the others show as not rated", () => {
    // The advocate rates OHI met; the skeptic and auditor leave it out (they judge it not suspected).
    const r = agree("agree", [rv("advocate", 1, [["ohi", "met", null], ["sld", "met", null]]), rv("skeptic", 1, [["sld", "met", null]]), rv("auditor", 1, [["sld", "met", null]])], verdict);
    expect(r.agreed.map((a) => a.item)).toEqual(["sld"]);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0].item).toBe("ohi");
    expect(r.disagreements[0].positions.map((p) => [p.reviewer, p.verdict, p.rationale])).toEqual([
      ["advocate", "met", "advocate on ohi"],
      ["skeptic", null, NOT_RATED],
      ["auditor", null, NOT_RATED],
    ]);
    expect(r.findings.map((f) => [f.kind, f.title])).toEqual([["reviewer_disagreement", "Not every reviewer rated: Ohi"]]);
    const table = agreeTable("agree", r, [{ key: "advocate", label: "Advocate" }, { key: "skeptic", label: "Skeptic" }]);
    expect(table.rows.find((row) => row.cells.item === "Ohi")?.cells).toMatchObject({ r_advocate: "met", r_skeptic: "not rated", status: "Disagreed" });
    // Score mode too: one score is not agreement.
    const s = agree("agree", [rv("a", 1, [["overall", null, 3]]), rv("b", 1, [])], { mode: "score", tolerance: 2, blockingVerdicts: [], meanTimes10: false });
    expect(s.agreed).toEqual([]);
    expect(s.disagreements.map((d) => d.item)).toEqual(["overall"]);
  });

  it("score mode: tolerance, median and range, mean × 10, and nothing averaged into a resolution", () => {
    const r = agree("agree1", [rv("a", 1, [["overall", null, 2], ["f1", null, 3]]), rv("b", 1, [["overall", null, 5], ["f1", null, 4]]), rv("c", 1, [["overall", null, 4], ["f1", null, 4]])], { mode: "score", tolerance: 2, blockingVerdicts: [], meanTimes10: true });
    expect(r.disagreements.map((d) => d.item)).toEqual(["overall"]);
    expect(r.disagreements[0].positions.map((p) => p.score)).toEqual([2, 5, 4]);
    expect(r.disagreements[0]).not.toHaveProperty("score");
    expect(r.agreed).toEqual([expect.objectContaining({ item: "f1", verdict: null })]);
    expect(r.agreed[0].positions.map((p) => p.score)).toEqual([3, 4, 4]);
    expect(r.scores).toEqual([
      { item: "overall", label: "Overall", median: 4, min: 2, max: 5, meanTimes10: 37, nodeId: "agree1" },
      { item: "f1", label: "F1", median: 4, min: 3, max: 4, meanTimes10: 37, nodeId: "agree1" },
    ]);
  });

  it("a round-2 rating replaces the reviewer's round-1 rating", () => {
    const reviews = [rv("a", 1, [["overall", null, 2]]), rv("b", 1, [["overall", null, 6]]), rv("b", 2, [["overall", null, 3]])];
    expect(latestRatings(reviews).byReviewer.get("b")!.ratings.get("overall")!.score).toBe(3);
    const r = agree("agree2", reviews, { mode: "score", tolerance: 2, blockingVerdicts: [], meanTimes10: false });
    expect(r.disagreements).toEqual([]);
    expect(r.scores[0]).toMatchObject({ median: 2.5, min: 2, max: 3, meanTimes10: null });
  });

  it("blocking verdicts make the item a blocker, agreed or not", () => {
    const cfg = { ...verdict, blockingVerdicts: ["cannot_proceed"] };
    const split = agree("agree", [rv("eng", 1, [["proceed", "cannot_proceed", null]]), rv("qa", 1, [["proceed", "proceed", null]])], cfg);
    expect(split.disagreements[0].blocking).toBe(true);
    expect(split.findings[0].severity).toBe("blocking");
    const all = agree("agree", [rv("eng", 1, [["proceed", "cannot_proceed", null]]), rv("qa", 1, [["proceed", "cannot_proceed", null]])], cfg);
    expect(all.agreed).toHaveLength(1);
    expect(all.findings.map((f) => [f.kind, f.severity])).toEqual([["blocking_verdict", "blocking"]]);
  });
});
