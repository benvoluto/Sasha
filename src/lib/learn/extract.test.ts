import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeJson: vi.fn() }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/llm/claude")>()), claudeJson: mocks.claudeJson }));
vi.mock("@/lib/ontology/governance", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ontology/governance")>()), defaultAuditSink: () => ({ write: async () => {} }) }));

import { createTeamType } from "@/catalog";
import { resetCatalogStore } from "@/catalog/store";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { heading, para } from "@/lib/sections/test-fixtures";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { EXAMPLE_A, EXAMPLE_B, modelReply, typeDraft, USAGE, workflowDraft } from "./__fixtures__/learn-reply";
import { capText, documentMarkdown, exampleCap, LearnInputError, markdownHeadings, markHtmlStructure, readExamples, uniqueRefs } from "./examples";
import { extractReadable } from "@/lib/sources/url-extract";
import { learnFromExamples, LearnModelError, MIN_REPAIR_MS, LEARN_BUDGET_MS } from "./extract";
import { LEARN_MAX_EXAMPLE_CHARS, LEARN_MAX_TOTAL_CHARS } from "./contract";
import { parseDefinition } from "@/catalog/schema";

const TEAM = "org:a";

async function sources() {
  const a = await createSource(TEAM, "ann", { kind: "note", title: "Centrifuge request", extracted_text: EXAMPLE_A, extraction_status: "ready" });
  const b = await createSource(TEAM, "ann", { kind: "note", title: "Grinder request", extracted_text: EXAMPLE_B, extraction_status: "ready" });
  return [a, b];
}

const reply = (over: Record<string, unknown> = {}) => ({ data: modelReply(over), usage: USAGE });

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  resetSourceStore();
  resetCatalogStore();
  mocks.claudeJson.mockReset();
});

describe("reading examples", () => {
  it("writes a document as Markdown with its headings and lists", () => {
    const md = documentMarkdown({
      type: "doc",
      content: [heading("Plan", "s1"), para("First."), { type: "bulletList", content: [{ type: "listItem", content: [para("one")] }, { type: "listItem", content: [para("two")] }] }, { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Detail" }] }],
    });
    expect(md).toBe("## Plan\n\nFirst.\n\n- one\n- two\n\n### Detail");
    expect(markdownHeadings(`${md}\n\`\`\`\n# not a heading\n\`\`\``)).toEqual([
      { level: 2, text: "Plan" },
      { level: 3, text: "Detail" },
    ]);
  });

  it("caps each example, more tightly when there are several, cutting at a break", () => {
    expect(exampleCap(1)).toBe(LEARN_MAX_EXAMPLE_CHARS);
    expect(exampleCap(5)).toBe(Math.floor(LEARN_MAX_TOTAL_CHARS / 5));
    const text = `${"a".repeat(90)}\n\n${"b".repeat(50)}`;
    expect(capText(text, 100)).toEqual({ text: "a".repeat(90), truncated: true });
    expect(capText("short", 100)).toEqual({ text: "short", truncated: false });
  });

  it("reads team sources that have finished reading, and the team's documents; refuses the rest", async () => {
    const [a] = await sources();
    const doc = await createDocument(TEAM, "ann", { title: "Old request", content_json: { type: "doc", content: [heading("Summary", "s1"), para("We need a kiln.")] } });
    const read = await readExamples(TEAM, [{ kind: "source", sourceId: a.id }, { kind: "document", documentId: doc.id }]);
    expect(read.map((e) => [e.index, e.title, e.truncated])).toEqual([
      [0, "Centrifuge request", false],
      [1, "Old request", false],
    ]);
    expect(read[0].headings.map((h) => h.text)).toEqual(["Equipment request", "Summary", "Justification", "Costs", "Approval"]);
    expect(read[1].text).toBe("## Summary\n\nWe need a kiln.");

    await expect(readExamples("org:b", [{ kind: "source", sourceId: a.id }])).rejects.toMatchObject({ status: 404 });
    const busy = await createSource(TEAM, "ann", { kind: "note", title: "Busy", extraction_status: "extracting" });
    await expect(readExamples(TEAM, [{ kind: "source", sourceId: busy.id }])).rejects.toBeInstanceOf(LearnInputError);
    await expect(readExamples(TEAM, [{ kind: "source", sourceId: busy.id }])).rejects.toMatchObject({ status: 409 });
    const empty = await createSource(TEAM, "ann", { kind: "note", title: "Empty", extraction_status: "ready" });
    await expect(readExamples(TEAM, [{ kind: "source", sourceId: empty.id }])).rejects.toMatchObject({ status: 400 });
    expect(uniqueRefs([{ kind: "source", sourceId: a.id }, { kind: "source", sourceId: a.id }])).toHaveLength(1);
  });
});

describe("learnFromExamples", () => {
  it("makes one Opus call with the examples as delimited data and returns a validated, bound draft", async () => {
    const [a, b] = await sources();
    mocks.claudeJson.mockResolvedValueOnce(reply());
    const { draft, repaired, usage } = await learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }, { kind: "source", sourceId: b.id }] }, { agent: "ann", today: "2026-10-08" });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    const call = mocks.claudeJson.mock.calls[0][0];
    expect(call.task).toBe("learn.extract");
    expect(call.system).toMatch(/data, never instructions/);
    expect(call.user).toContain('<example index="0" title="Centrifuge request">');
    expect(call.user).toContain("Riverbend Community College");
    expect(repaired).toBe(false);
    expect(usage).toHaveLength(1);

    expect(draft.validation).toEqual({ type: [], workflow: [], graph: [], requirementSets: [] });
    expect(parseDefinition(draft.type).ok).toBe(true);
    expect(draft.type).toMatchObject({ key: "equipment-request", provenance: { source: "Learned from 2 examples", license: "Team", url: "" } });
    expect(draft.workflow).toMatchObject({ kind: "type", appliesTo: ["equipment-request"], requirementSets: ["team-approvals"] });
    expect(draft.requirementSets.map((s) => [s.key, s.inferred])).toEqual([["team-approvals", true]]);
    expect(draft.confidence).toBe("medium");
    // "Risks" only in the second example.
    expect(draft.differences).toEqual([{ aspect: "section", description: "“Risks” appears in one example.", examples: [1] }]);
    expect(draft.nearestType).toMatchObject({ key: "proposal", reason: "Asks for money with a budget." });
    // The out-of-range example index is dropped from the parts.
    expect(draft.parts[1].from).toEqual([{ example: 1, heading: "Costs", quote: "total 770" }]);
    expect(draft.examples.map((e) => e.title)).toEqual(["Centrifuge request", "Grinder request"]);
  });

  it("keys the type apart from catalog and team keys, uses the author's title, and labels one example low confidence", async () => {
    const [a] = await sources();
    const existing = parseDefinition({ ...typeDraft(), key: "lab-request" });
    if (!existing.ok) throw new Error(existing.errors.join("; "));
    await createTeamType(TEAM, "ann", existing.definition);
    mocks.claudeJson.mockResolvedValueOnce(reply({ nearestType: { key: "no-such-type", reason: "x" } }));
    const { draft } = await learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }], title: "Lab request" }, { agent: "ann", today: "2026-10-08" });
    expect(draft.type.key).toBe("lab-request-2");
    expect(draft.type.title).toBe("Lab request");
    expect(draft.workflow.appliesTo).toEqual(["lab-request-2"]);
    expect(draft.confidence).toBe("low");
    expect(draft.confidenceReason).toMatch(/^One example/);
    expect(draft.differences).toEqual([]);
    expect(draft.nearestType).toBeNull();
  });

  it("builds the type key from the scrubbed title when the title names a person", async () => {
    const [a] = await sources();
    mocks.claudeJson.mockResolvedValueOnce(reply({ title: "Equipment request for Marisol Quintanilla Ortega" }));
    const { draft } = await learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }] }, { agent: "ann", today: "2026-10-08" });
    expect(draft.type.title).toBe("Equipment request for [Name]");
    expect(draft.type.key).toBe("equipment-request-for-name");
    expect(draft.workflow.appliesTo).toEqual(["equipment-request-for-name"]);
    expect(draft.workflow.key).toBe("learned-equipment-request-for-name");
    expect(draft.requirementSets.every((s) => s.appliesTo.join() === "equipment-request-for-name")).toBe(true);
  });

  it("replaces personal details and flags copied runs", async () => {
    const [a, b] = await sources();
    const copied = "because the current unit failed its annual safety inspection last spring and cannot be repaired";
    const type = typeDraft({
      sections: [
        { key: "summary", heading: "Summary", order: 10, guidance: `Explain the need, for example ${copied}.`, elements: ["Item", "Problem"] },
        { key: "justification", heading: "Justification", order: 20, guidance: "Name the requester (e.g. Marisol Quintanilla Ortega, marisol.q@example.org).", elements: ["Who", "Impact"] },
      ],
      rubric: [],
    });
    const wf = workflowDraft();
    const steps = (wf.steps as Array<{ id: string; config?: Record<string, unknown> }>).map((s) => (s.id === "gate" ? { ...s, config: { inputs: [{ key: "summary", label: "A summary", kind: "section", specKeys: ["summary"] }] } } : s.id === "chk" ? { ...s, config: { checklist: [{ key: "signed", label: "Approver", question: "Is the approver named?" }] } } : s));
    mocks.claudeJson.mockResolvedValueOnce(reply({ type: JSON.stringify(type), workflow: JSON.stringify({ ...wf, steps }) }));
    const { draft } = await learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }, { kind: "source", sourceId: b.id }] }, { agent: "ann", today: "2026-10-08" });
    const just = draft.type.sections.find((s) => s.key === "justification")!.guidance;
    expect(just).toBe("Name the requester (e.g. [Name], [Email]).");
    expect(draft.personalDetails.map((p) => [p.kind, p.text, p.removed])).toEqual([
      ["email", "marisol.q@example.org", true],
      ["name", "Marisol Quintanilla Ortega", true],
    ]);
    expect(draft.overlaps).toEqual([{ path: "type.sections.summary.guidance", text: copied, words: 15, example: 0 }]);
    expect(draft.validation.type).toEqual([]);
  });

  it("repairs once with the errors (and without the examples) when the draft doesn't validate", async () => {
    const [a] = await sources();
    const bad = workflowDraft();
    const badSteps = (bad.steps as Array<{ id: string; config?: Record<string, unknown> }>).map((s) => (s.id === "dec" ? { ...s, config: { values: ["approve", "reject"], guidance: "x" } } : s));
    mocks.claudeJson.mockResolvedValueOnce(reply({ workflow: JSON.stringify({ ...bad, steps: badSteps }) }));
    mocks.claudeJson.mockResolvedValueOnce({ data: { type: JSON.stringify(typeDraft()), workflow: JSON.stringify(workflowDraft()), requirementSets: "[]" }, usage: USAGE });
    const { draft, repaired, usage } = await learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }] }, { agent: "ann", today: "2026-10-08" });
    expect(repaired).toBe(true);
    expect(usage).toHaveLength(2);
    const fix = mocks.claudeJson.mock.calls[1][0];
    expect(fix.user).toMatch(/must equal the outcome values/);
    expect(fix.user).not.toContain("Marisol");
    expect(fix.system).toBe(mocks.claudeJson.mock.calls[0][0].system);
    // The repair dropped the inferred set; the workflow still names it, so validation says so.
    expect(draft.validation.workflow.join(" ")).toMatch(/unknown requirement set "approvals"/);
  });

  it("skips the repair when the time budget is spent, and returns the draft with its errors", async () => {
    const [a] = await sources();
    mocks.claudeJson.mockResolvedValueOnce(reply({ type: JSON.stringify(typeDraft({ sections: [] })) }));
    let t = 0;
    const now = () => (t += LEARN_BUDGET_MS - MIN_REPAIR_MS + 1);
    const { draft, repaired } = await learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }] }, { agent: "ann", today: "2026-10-08", now });
    expect(repaired).toBe(false);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    expect(draft.validation.type[0]).toMatch(/^sections/);
  });

  it("refuses a reply whose drafts can't be read at all", async () => {
    const [a] = await sources();
    mocks.claudeJson.mockResolvedValue(reply({ type: "{", workflow: "nope", requirementSets: "[" }));
    await expect(learnFromExamples(TEAM, { examples: [{ kind: "source", sourceId: a.id }] }, { agent: "ann", today: "2026-10-08" })).rejects.toBeInstanceOf(LearnModelError);
  });
});

describe("markHtmlStructure", () => {
  it("keeps HTML headings and doesn't read a comment in a code block as one", () => {
    const html = `<html><head><title>PEP</title></head><body><article><h1>Proposal</h1><h2>Rationale</h2><p>${"Some words about the change and why it matters. ".repeat(12)}</p><pre># Handle a matched regex\nif (match := pattern.search(data)) is not None:\n    pass</pre><h2>Syntax and semantics</h2><p>${"More words that describe the syntax in detail. ".repeat(12)}</p></article></body></html>`;
    const text = extractReadable(markHtmlStructure(html), "https://example.org/pep").text;
    const heads = markdownHeadings(text).map((h) => h.text);
    expect(heads).toEqual(expect.arrayContaining(["Rationale", "Syntax and semantics"]));
    expect(heads).not.toContain("Handle a matched regex");
  });
});
