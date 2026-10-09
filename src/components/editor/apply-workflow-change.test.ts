import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SectionSummary } from "@/catalog/schema";
import type { PMNode } from "@/lib/documents/sections";
import type { DocumentChangeOp, RestructurePlan } from "@/lib/workflow/contract";
import { collectCitations } from "@/lib/citations/contract";
import { changeDetail, DRIFT_ERROR, markSupported, markUnsourced, planWorkflowChange, type ChangeDeps, type RestructureFn } from "./apply-workflow-change";

const text = (t: string, marks?: PMNode["marks"]): PMNode => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const p = (...content: PMNode[]): PMNode => ({ type: "paragraph", ...(content.length ? { content } : {}) });
const h = (heading: string, sectionId: string, specKey: string | null = null, level = 2): PMNode => ({ type: "heading", attrs: { level, sectionId, specKey }, content: [text(heading)] });
const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content });

const draftOp = (over: Partial<Extract<DocumentChangeOp, { op: "replace_section_body" }>> = {}): DocumentChangeOp => ({
  op: "replace_section_body",
  sectionId: "s-methods",
  specKey: "methods",
  heading: "Methods",
  level: 2,
  markdown: "We surveyed 40 sites. The response rate was high.",
  onlyIfEmpty: true,
  trace: [
    { text: "We surveyed 40 sites.", support: [], unsourced: false },
    { text: "The response rate was high.", support: [], unsourced: true },
  ],
  ...over,
});

const noRestructure: RestructureFn = () => {
  throw new Error("not expected");
};
const deps = (over: Partial<ChangeDeps> = {}): ChangeDeps => ({ sectionsFor: () => [], newId: () => "new-id", restructure: noRestructure, ...over });

const highlighted = (n: PMNode): string[] =>
  (n.content ?? []).flatMap((c) => (c.marks?.some((m) => m.type === "highlight") ? [c.text ?? ""] : c.content ? highlighted(c) : []));

describe("planWorkflowChange: replace_section_body", () => {
  const base = doc(h("Intro", "s-intro"), p(text("Hello.")), h("Methods", "s-methods", "methods"), p(), h("Results", "s-results", "results"), p(text("Found it.")));

  it("fills an empty section and highlights the unsourced sentence", () => {
    const r = planWorkflowChange(base, { ops: [draftOp()] }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(1);
    expect(r.marked).toBe(1);
    const nodes = r.doc.content!;
    expect(nodes[2].attrs?.sectionId).toBe("s-methods");
    expect(nodes[3].type).toBe("paragraph");
    expect(highlighted(nodes[3])).toEqual(["The response rate was high."]);
    // The sourced sentence is plain, and the next section is untouched.
    expect(nodes[3].content!.map((c) => c.text).join("")).toBe("We surveyed 40 sites. The response rate was high.");
    expect(nodes[4].attrs?.sectionId).toBe("s-results");
    expect(nodes[5].content![0].text).toBe("Found it.");
  });

  it("skips (and reports) a section that has text by now when onlyIfEmpty", () => {
    const filled = doc(h("Methods", "s-methods", "methods"), p(text("I wrote this myself.")));
    const r = planWorkflowChange(filled, { ops: [draftOp()] }, deps());
    expect(r.ok && r.applied).toBe(0);
    expect(r.ok && r.skipped[0]).toMatch(/Methods.*has text now/);
    expect(r.ok && r.doc.content![1].content![0].text).toBe("I wrote this myself.");
  });

  it("replaces a section with text when onlyIfEmpty is off", () => {
    const filled = doc(h("Methods", "s-methods", "methods"), p(text("Old words.")), h("Next", "s-next", "next"));
    const r = planWorkflowChange(filled, { ops: [draftOp({ onlyIfEmpty: false, trace: [] })] }, deps());
    expect(r.ok && r.applied).toBe(1);
    expect(r.ok && r.doc.content!.map((n) => n.content?.[0]?.text)).toEqual(["Methods", "We surveyed 40 sites. The response rate was high.", "Next"]);
  });

  it("finds the section by specKey when the sectionId is gone (after a restructure)", () => {
    const moved = doc(h("Methods", "fresh-id", "methods"), p());
    const r = planWorkflowChange(moved, { ops: [draftOp()] }, deps());
    expect(r.ok && r.applied).toBe(1);
  });

  it("reports a section that is no longer there", () => {
    const r = planWorkflowChange(doc(h("Intro", "s-intro"), p()), { ops: [draftOp()] }, deps());
    expect(r.ok && r.skipped[0]).toMatch(/no longer in the document/);
  });

  it("keeps every op of one change in one resulting document", () => {
    const two = doc(h("Methods", "s-methods", "methods"), p(), h("Results", "s-results", "results"), p());
    const r = planWorkflowChange(two, { ops: [draftOp(), draftOp({ sectionId: "s-results", specKey: "results", heading: "Results", markdown: "Numbers went up.", trace: [] })] }, deps());
    expect(r.ok && r.applied).toBe(2);
    expect(r.ok && r.doc.content!.map((n) => (n.content ?? []).map((c) => c.text).join(""))).toEqual(["Methods", "We surveyed 40 sites. The response rate was high.", "Results", "Numbers went up."]);
  });
});

describe("markUnsourced", () => {
  it("splits text nodes at sentence edges and keeps their other marks", () => {
    const { blocks, marked } = markUnsourced([p(text("One. "), text("Two is bold.", [{ type: "bold" }]), text(" Three."))], ["Two is bold.", "Missing."]);
    expect(marked).toBe(1);
    const [para] = blocks;
    expect(para.content!.map((c) => [c.text, (c.marks ?? []).map((m) => m.type)])).toEqual([
      ["One. ", []],
      ["Two is bold.", ["bold", "highlight"]],
      [" Three.", []],
    ]);
  });

  it("marks a sentence that spans text nodes", () => {
    const { blocks } = markUnsourced([p(text("A b"), text("c d."))], ["b" + "c d."]);
    expect(highlighted(blocks[0])).toEqual(["b", "c d."]);
  });

  it("reaches paragraphs inside lists", () => {
    const list: PMNode = { type: "bulletList", content: [{ type: "listItem", content: [p(text("Claim one."))] }] };
    const { blocks, marked } = markUnsourced([list], ["Claim one."]);
    expect(marked).toBe(1);
    expect(highlighted(blocks[0])).toEqual(["Claim one."]);
  });
});

const support = (ref: string, sourceId = "src-1") => ({ kind: "passage" as const, ref, sourceId, label: "Report", quote: "passage text", page: 2, stance: "for" as const, verified: true });
const citedIds = (n: PMNode): Array<[string, string[]]> =>
  (n.content ?? []).flatMap((c) => (c.type === "text" ? [[c.text ?? "", (c.marks ?? []).filter((m) => m.type === "citation").map((m) => String(m.attrs?.passageId))] as [string, string[]]] : c.content ? citedIds(c) : []));

describe("markSupported", () => {
  it("puts a citation mark per passage support on each traced sentence, and none for note support", () => {
    const trace = [
      { text: "We surveyed 40 sites.", support: [support("S1a2b3c4d.P1"), support("S1a2b3c4d.P4")], unsourced: false },
      { text: "Notes said so.", support: [{ ...support("s-methods"), kind: "note" as const, sourceId: null }], unsourced: false },
      { text: "The response rate was high.", support: [], unsourced: true },
    ];
    const { blocks, cited } = markSupported([p(text("We surveyed 40 sites. Notes said so. The response rate was high."))], trace);
    expect(cited).toBe(1);
    expect(citedIds(blocks[0])).toEqual([
      ["We surveyed 40 sites.", ["S1a2b3c4d.P1", "S1a2b3c4d.P4"]],
      [" Notes said so. The response rate was high.", []],
    ]);
    const mark = blocks[0].content![0].marks![0];
    expect(mark).toEqual({ type: "citation", attrs: { kind: "passage", passageId: "S1a2b3c4d.P1", sourceId: "src-1", dataTableId: null, quote: null, verified: true } });
  });
});

describe("planWorkflowChange: traced support becomes citations", () => {
  it("cites the sourced sentence and still highlights the unsourced one", () => {
    const base = doc(h("Methods", "s-methods", "methods"), p());
    const op = draftOp({
      trace: [
        { text: "We surveyed 40 sites.", support: [support("S1a2b3c4d.P1")], unsourced: false },
        { text: "The response rate was high.", support: [], unsourced: true },
      ],
    });
    const r = planWorkflowChange(base, { ops: [op] }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marked).toBe(1);
    const body = r.doc.content![1];
    expect(citedIds(body)[0]).toEqual(["We surveyed 40 sites.", ["S1a2b3c4d.P1"]]);
    expect(highlighted(body)).toEqual(["The response rate was high."]);
    expect(collectCitations(r.doc).references.map((x) => x.key)).toEqual(["p:S1a2b3c4d.P1"]);
  });
});

const plan: RestructurePlan = {
  targetType: "general-report",
  targetTitle: "General report",
  mode: "merge",
  basisUpdatedAt: "2026-10-08T00:00:00.000Z",
  blockHashes: ["a", "b"],
  rows: [{ id: "R1", from: 0, to: 1, heading: "Intro", excerpt: "Hello.", target: "summary", reason: "It summarizes." }],
  gaps: [],
};
const sections: SectionSummary[] = [{ key: "summary", heading: "Executive summary", level: 2, order: 1, required: true, elements: [], renderer: "prose", lengthHint: null, scaffold: null } as unknown as SectionSummary];

describe("planWorkflowChange: restructure", () => {
  const base = doc(h("Intro", "s-intro"), p(text("Hello.")));

  it("refuses a plan when the document drifted", () => {
    const restructure = vi.fn<RestructureFn>(() => ({ doc: base, drift: true }));
    const r = planWorkflowChange(base, { ops: [{ op: "restructure", plan }] }, deps({ restructure, sectionsFor: () => sections }));
    expect(r).toEqual({ ok: false, error: DRIFT_ERROR });
  });

  it("uses the restructured document, sets the type, then fills by specKey", () => {
    const after = doc(h("Executive summary", "s-intro", "summary"), p(text("Hello.")), h("Findings", "new-id", "findings"), p());
    const restructure = vi.fn<RestructureFn>(() => ({ doc: after, drift: false }));
    const fill = draftOp({ sectionId: null, specKey: "findings", heading: "Findings", markdown: "New text.", trace: [] });
    const r = planWorkflowChange(base, { ops: [{ op: "restructure", plan }, fill] }, deps({ restructure, sectionsFor: (k) => (k === "general-report" ? sections : null) }));
    expect(restructure).toHaveBeenCalledWith(expect.objectContaining({ type: "doc" }), plan, sections, expect.any(Function));
    expect(r.ok && r.typeKey).toBe("general-report");
    expect(r.ok && r.applied).toBe(2);
    expect(r.ok && r.doc.content!.at(-1)!.content![0].text).toBe("New text.");
  });

  it("refuses a type the team doesn't have", () => {
    const r = planWorkflowChange(base, { ops: [{ op: "restructure", plan }] }, deps({ sectionsFor: () => null }));
    expect(r.ok).toBe(false);
  });

  // The real applyRestructurePlan (workflow-defs track), once it is in the tree.
  const restructurePath = fileURLToPath(new URL("../../lib/workflow/restructure.ts", import.meta.url));
  it.skipIf(!existsSync(restructurePath))("works with applyRestructurePlan: refuses drift, keeps every word", async () => {
    const mod = (await import(/* @vite-ignore */ restructurePath)) as { applyRestructurePlan: RestructureFn; blockHashes: (d: PMNode) => string[] };
    const real = deps({ restructure: mod.applyRestructurePlan, sectionsFor: () => sections });
    expect(planWorkflowChange(base, { ops: [{ op: "restructure", plan: { ...plan, blockHashes: [] } }] }, real)).toEqual({ ok: false, error: DRIFT_ERROR });
    const r = planWorkflowChange(base, { ops: [{ op: "restructure", plan: { ...plan, blockHashes: mod.blockHashes(base) } }] }, real);
    expect(r.ok && r.typeKey).toBe("general-report");
    const words = (n: PMNode): string => (n.text ?? "") + (n.content ?? []).map(words).join(" ");
    expect(r.ok && words(r.doc)).toContain("Hello.");
  });

  it.skipIf(!existsSync(restructurePath))("removes the plan's dropped headings and says so", async () => {
    const mod = (await import(/* @vite-ignore */ restructurePath)) as { applyRestructurePlan: RestructureFn; blockHashes: (d: PMNode) => string[] };
    const withEmpty = doc(h("Old part", "s-old"), h("Intro", "s-intro"), p(text("Hello.")));
    const pl: RestructurePlan = { ...plan, blockHashes: mod.blockHashes(withEmpty), rows: [{ ...plan.rows[0], from: 1, to: 2 }], dropped: [{ index: 0, heading: "Old part", level: 2 }] };
    const r = planWorkflowChange(withEmpty, { ops: [{ op: "restructure", plan: pl }] }, deps({ restructure: mod.applyRestructurePlan, sectionsFor: () => sections }));
    if (!r.ok) throw new Error(r.error);
    expect(JSON.stringify(r.doc)).not.toContain("Old part");
    expect(r.removed).toEqual(["Old part"]);
    expect(changeDetail(r)).toMatch(/Removed 1 heading with no text of its own: “Old part”/);
  });
});
