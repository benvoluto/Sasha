import { beforeEach, describe, expect, it, vi } from "vitest";

const { claudeJson, claudeSearch } = vi.hoisted(() => ({ claudeJson: vi.fn(), claudeSearch: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson, claudeSearch }));

import { fileTypeByKey } from "@/catalog/files";
import { getSectionMeta } from "@/lib/documents/section-store";
import { listSuggestions } from "@/lib/suggestions/store";
import type { DocumentChangeOp, Finding, ProposedChange } from "../contract";
import { buildCoverage, coverageNeeds, typeCoverage } from "./coverage";
import { docRead, snapshotDocument } from "./readers";
import { rubricScore } from "./rubric";
import { ctxFor, heading, makeDocument, nodeOf, para, resetStores, TEAM, USAGE } from "./test-fixtures";
import type { CoverageRow, DocSnapshot, RubricScore, WebResource } from "./types";
import { EvidenceIndex } from "./util";
import { filterResources, NOT_SET_UP, webFind, webQuery } from "./web-find";
import { docWrite, flattenOps, suggestEmit, UNVERIFIED_PREFIX } from "./write";

beforeEach(() => {
  resetStores();
  claudeJson.mockReset();
  claudeSearch.mockReset();
});

describe("type.coverage", () => {
  it("scores the type's needs (sources, data, elements) and downgrades support it can't check", () => {
    const def = fileTypeByKey("proposal")!;
    const needs = coverageNeeds(def, true);
    expect(needs[0].id).toBe("N1");
    expect(needs.some((n) => n.kind === "element")).toBe(true);
    const S = { sources: [{ id: "a", title: "Quote", kind: "note", role: null, summary: "", status: "ready", url: null }], passages: [{ id: "Sa.P1", sourceId: "a", page: 2, text: "Total cost £38,400." }] };
    const rows = buildCoverage(
      {
        rows: [
          { need: "N1", status: "supported", evidence: [{ id: "Sa.P1", quote: "£38,400" }], note: "The quote." },
          { need: "N2", status: "supported", evidence: [{ id: "Sbogus.P1", quote: "" }], note: "Invented." },
          { need: "N99", status: "supported", evidence: [], note: "" },
        ],
      },
      needs.slice(0, 3),
      new EvidenceIndex({ sources: S }),
    );
    expect(rows.map((r) => r.status)).toEqual(["supported", "missing", "missing"]);
    expect(rows[0].evidence[0]).toMatchObject({ kind: "passage", sourceId: "a", page: 2, verified: true });
  });

  it("emits gaps and findings (weak minor, missing major, kind coverage_gap)", async () => {
    const { doc } = await makeDocument({ typeKey: "proposal" });
    const needs = coverageNeeds(fileTypeByKey("proposal")!, true);
    claudeJson.mockResolvedValue({ data: { rows: needs.map((n, i) => ({ need: n.id, status: i === 0 ? "weak" : "missing", evidence: i === 0 ? [{ id: "doc", quote: "" }] : [], note: "" })) }, usage: USAGE });
    const D = (await docRead({}, nodeOf("doc.read"), ctxFor(doc.id))) as { document: DocSnapshot };
    const out = (await typeCoverage({ document: D.document }, nodeOf("type.coverage"), ctxFor(doc.id))) as { gaps: CoverageRow[]; findings: Finding[] };
    expect(claudeJson.mock.calls[0][0].task).toBe("coverage.score");
    expect(out.gaps).toHaveLength(needs.length);
    expect(out.findings[0]).toMatchObject({ kind: "coverage_gap", severity: "minor" });
    expect(out.findings[1]).toMatchObject({ kind: "coverage_gap", severity: "major" });
  });
});

describe("web.find", () => {
  const CANARY = "CANARY-JANE-Q-STUDENT-4412";

  it("sensitive type: no document text in any prompt, catalog gap labels only, allowed_domains = the policy's", async () => {
    const { doc } = await makeDocument({
      title: `FIE for ${CANARY}`,
      typeKey: "fie",
      notes: `Notes about ${CANARY}`,
      content: [heading("Reason for Referral", "r1", "reason_for_referral"), para(`${CANARY} was referred for reading concerns.`)],
      sources: [{ title: `${CANARY} records`, summary: `Records of ${CANARY}`, passages: [`${CANARY} scored 82.`] }],
    });
    const ctx = ctxFor(doc.id);
    const D = ((await docRead({}, nodeOf("doc.read"), ctx)) as { document: DocSnapshot }).document;
    expect(JSON.stringify(D)).toContain(CANARY);
    const catalogNeed = coverageNeeds(fileTypeByKey("fie")!, true)[0];
    const gaps = [
      { need: catalogNeed.need, kind: catalogNeed.kind, specKey: catalogNeed.specKey, heading: catalogNeed.heading, status: "missing", evidence: [], note: `Nothing for ${CANARY}` },
      // A gap that isn't one of the type's needs (document text wired in) never goes out.
      { need: `${CANARY} reading scores`, kind: "source", specKey: null, heading: CANARY, status: "missing", evidence: [], note: "" },
    ];
    claudeSearch.mockResolvedValue({ data: { resources: [] }, searchedUrls: [], usage: USAGE });
    await webFind({ gaps, document: D }, nodeOf("web.find"), ctx);
    expect(claudeSearch).toHaveBeenCalledTimes(1);
    const call = claudeSearch.mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain(CANARY);
    expect(call.user).toContain(catalogNeed.need);
    expect(call.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 4, allowed_domains: ["law.cornell.edu", "tea.texas.gov", "ed.gov", "sites.ed.gov", "texreg.sos.state.tx.us"] }]);
    expect(call.task).toBe("web.find");
  });

  it("sensitive type with no domains fails", async () => {
    const { doc } = await makeDocument({ typeKey: "fie" });
    const ctx = ctxFor(doc.id, { policy: { sensitive: true, webDomains: [] } });
    await expect(webFind({ gaps: [{ need: "x" }] }, nodeOf("web.find"), ctx)).rejects.toThrow(NOT_SET_UP);
    expect(claudeSearch).not.toHaveBeenCalled();
  });

  it("keeps only URLs a search returned, http(s), within the domains, for a known gap; all unverified", () => {
    const q = webQuery({ sensitive: false, webDomains: [] }, null, { title: "Plan" }, [{ need: "Market data", specKey: "market", heading: "Market" }], { maxResults: 5, maxSearches: 2, allowedDomains: ["census.gov"], blockedDomains: [] });
    expect(q.user).toContain("Plan");
    const res = filterResources(
      {
        resources: [
          { url: "https://www.census.gov/data/table#x", title: "Census tables", publisher: "US Census", why: "Market size.", gap: "G1" },
          { url: "https://census.gov/invented", title: "Never searched", publisher: "", why: "", gap: "G1" },
          { url: "https://example.com/a", title: "Off-domain", publisher: "", why: "", gap: "G1" },
          { url: "javascript:alert(1)", title: "Bad", publisher: "", why: "", gap: "G1" },
          { url: "https://census.gov/other", title: "Unknown gap", publisher: "", why: "", gap: "G9" },
        ],
      },
      ["https://www.census.gov/data/table/", "https://example.com/a", "https://census.gov/other"],
      q,
      5,
    );
    expect(res).toEqual([{ url: "https://www.census.gov/data/table#x", title: "Census tables", publisher: "US Census", why: "Market size.", need: "Market data", specKey: "market", verified: false }]);
  });
});

describe("rubric.score", () => {
  it("scope drafted: scores the drafts in place of the empty sections; level 1 major, level 2 minor", async () => {
    const { doc } = await makeDocument({ typeKey: "proposal", content: [heading("Summary", "s1", "summary"), para(""), heading("Budget", "b1", "budget"), para("Old budget text.")] });
    const D = snapshotDocument(doc, fileTypeByKey("proposal")!, 8000);
    const crit = D.type!.rubric.slice(0, 3).map((c) => c.key);
    claudeJson.mockResolvedValue({
      data: {
        scores: [
          { criterion: crit[0], level: 1, rationale: "Thin.", evidence: [{ id: "s1", quote: "We request £40,000" }], fix: "Add the amount." },
          { criterion: crit[1], level: 2, rationale: "Ok.", evidence: [], fix: "" },
          { criterion: crit[2], level: 9, rationale: "Great.", evidence: [], fix: "" },
          { criterion: "made_up", level: 1, rationale: "", evidence: [], fix: "" },
        ],
      },
      usage: USAGE,
    });
    const drafts = [{ sectionId: "s1", specKey: "summary", heading: "Summary", level: 2, markdown: "We request £40,000 to restore the path.", trace: [], unsourced: 0 }];
    const out = (await rubricScore({ document: D, drafts: [drafts] }, nodeOf("rubric.score", { scope: "drafted", criteria: crit }), ctxFor(doc.id))) as { scores: RubricScore[]; findings: Finding[] };
    const user = claudeJson.mock.calls[0][0].user as string;
    expect(claudeJson.mock.calls[0][0].task).toBe("rubric.check");
    expect(user).toContain("We request £40,000");
    expect(user).not.toContain("Old budget text.");
    expect(out.scores.map((s) => [s.criterion, s.level])).toEqual([
      [crit[0], 1],
      [crit[1], 2],
      [crit[2], 4],
    ]);
    expect(out.scores[0].evidence[0]).toMatchObject({ kind: "document", ref: "s1", verified: true });
    expect(out.findings.map((f) => [f.kind, f.severity])).toEqual([
      ["rubric", "major"],
      ["rubric", "minor"],
    ]);
  });

  it("scope drafted with no drafts makes no call", async () => {
    const { doc } = await makeDocument({ typeKey: "proposal" });
    const D = snapshotDocument(doc, fileTypeByKey("proposal")!, 8000);
    const out = (await rubricScore({ document: D, drafts: [[]] }, nodeOf("rubric.score", { scope: "drafted", criteria: [] }), ctxFor(doc.id))) as { scores: unknown[] };
    expect(out.scores).toEqual([]);
    expect(claudeJson).not.toHaveBeenCalled();
  });
});

const op = (sectionId: string): DocumentChangeOp => ({ op: "replace_section_body", sectionId, specKey: null, heading: sectionId, level: 2, markdown: "Text.", onlyIfEmpty: true, trace: [{ text: "Text.", support: [], unsourced: true }] });

describe("doc.write", () => {
  it("flattens ops, lists of ops and {op} records", () => {
    const plan = { op: "restructure" as const, plan: { targetType: "proposal", targetTitle: "Proposal", mode: "merge" as const, basisUpdatedAt: "", blockHashes: [], rows: [], gaps: [] } };
    expect(flattenOps([[op("a"), op("b")], { op: plan }, [{ op: op("c") }], null, { other: 1 }]).map((o) => (o.op === "restructure" ? "R" : o.sectionId))).toEqual(["a", "b", "R", "c"]);
  });

  it("editor: proposes the change and writes nothing", async () => {
    const { doc } = await makeDocument({ content: [heading("A", "a"), para("")] });
    const out = (await docWrite({ ops: [[op("a")]] }, nodeOf("doc.write", { title: "Drafts", snapshotReason: "Before drafts" }, "write"), ctxFor(doc.id))) as { change: ProposedChange };
    expect(out.change).toEqual({ id: "write", title: "Drafts", summary: "Fills 1 section (1 unsourced sentence marked).", ops: [op("a")], basisUpdatedAt: doc.updated_at, snapshotReason: "Before drafts" });
    const { getDocument } = await import("@/lib/documents/store");
    expect((await getDocument(TEAM, doc.id))!.updated_at).toBe(doc.updated_at);
  });

  it("section_notes: appends each finding to its section's notes once", async () => {
    const { doc } = await makeDocument({ content: [heading("A", "a"), para("x")] });
    const f: Finding = { id: "c:1", nodeId: "c", kind: "k", severity: "major", status: null, title: "Missing total", detail: "No total line.", location: { sectionId: "a", specKey: null, heading: "A", quote: "" }, evidence: [{ kind: "passage", ref: "Sx.P1", sourceId: "x", label: "Quote", quote: "", page: 2, stance: "neutral", verified: true }], reviewer: null, verified: true, fix: "" };
    const node = nodeOf("doc.write", { target: "section_notes" });
    const loose = { ...f, id: "c:2", location: null };
    const out = await docWrite({ findings: [[f, loose]] }, node, ctxFor(doc.id));
    expect(out).toEqual({ change: { target: "section_notes", sections: 1, written: 1, skipped: 1 } });
    await docWrite({ findings: [f] }, node, ctxFor(doc.id));
    const notes = (await getSectionMeta(TEAM, doc.id, "a"))!.notes;
    expect(notes).toBe("[Test workflow] Missing total\nNo total line.\nRests on: Quote p.2");
  });
});

describe("suggest.emit", () => {
  it("writes gaps (sources and data) and web resources as coverage suggestions, web ones unverified", async () => {
    const { doc } = await makeDocument({ typeKey: "proposal" });
    const gaps: CoverageRow[] = [
      { need: "Quotes or cost estimates", kind: "source", specKey: "budget", heading: "Budget", status: "missing", evidence: [], note: "" },
      { need: "Total", kind: "element", specKey: "budget", heading: "Budget", status: "missing", evidence: [], note: "" },
    ];
    const resources: WebResource[] = [{ url: "https://www.gov.uk/guidance/x", title: "Costing guidance", publisher: "GOV.UK", why: "How to cost works.", need: "Quotes or cost estimates", specKey: "budget", verified: false }];
    const out = await suggestEmit({ gaps, resources: [resources] }, nodeOf("suggest.emit"), ctxFor(doc.id));
    expect(out).toEqual({ suggestions: { open: 2, added: 0 } });
    const list = (await listSuggestions(TEAM, doc.id))!;
    expect(list.map((s) => [s.kind, s.label, s.origin])).toEqual([
      ["source", "Quotes or cost estimates", "coverage"],
      ["web", "Costing guidance", "coverage"],
    ]);
    const web = list.find((s) => s.kind === "web")!;
    expect(web.url).toBe("https://www.gov.uk/guidance/x");
    expect(web.reason.startsWith(UNVERIFIED_PREFIX)).toBe(true);
  });
});
