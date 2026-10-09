import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SectionSummary } from "@/catalog/schema";
import type { PMNode } from "@/lib/documents/sections";
import type { DocumentChangeOp, ReplaceLine, RestructurePlan } from "@/lib/workflow/contract";
import { collectCitations } from "@/lib/citations/contract";
import { applyWorkflowChange, changeDetail, DRIFT_ERROR, LINE_GONE, LINE_HAS_ITEMS, LINE_NOT_IN_LIST, markSupported, markUnsourced, planWorkflowChange, SAVE_FIRST, type ChangeDeps, type RestructureFn } from "./apply-workflow-change";

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

// --- replace_lines (resume Tailor step, tailor-spec.md §6.1) ---

const li = (t: string): PMNode => ({ type: "listItem", content: [p(text(t))] });
const ul = (...items: string[]): PMNode => ({ type: "bulletList", content: items.map(li) });
const line = (over: Partial<ReplaceLine> & Pick<ReplaceLine, "id" | "original">): ReplaceLine => ({
  action: "rewrite",
  sectionId: "s-exp",
  heading: "Experience",
  proposed: "",
  reason: "Matches a requirement.",
  requirementKeys: [],
  evidence: [],
  ...over,
});
const linesOp = (...lines: ReplaceLine[]): DocumentChangeOp => ({ op: "replace_lines", lines });
const texts = (n: PMNode | undefined): string[] => (n?.content ?? []).map((c) => (c.content ?? []).map((x) => x.text ?? (x.content ?? []).map((y) => y.text).join("")).join(""));

describe("planWorkflowChange: replace_lines", () => {
  const resume = () =>
    doc(
      p(text("Ada Lovelace · ada@example.com")),
      h("Summary", "s-sum"),
      p(text("Engineer with a decade of work.")),
      p(text("Enjoys puzzles.")),
      h("Experience", "s-exp"),
      ul("Built the billing system.", "Led a team of 6.", "Ran the office party."),
      h("Skills", "s-skills"),
      ul("Python"),
    );

  it("rewrites a list line and cites its master passages", () => {
    const r = planWorkflowChange(resume(), { ops: [linesOp(line({ id: "L1", original: "Built the billing system.", proposed: "Built the billing system in Python.", evidence: [support("S1.P2")] }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.applied).toBe(1);
    expect(r.lines).toEqual([{ lineId: "L1", result: "accepted", detail: "Rewritten" }]);
    expect(texts(r.doc.content![5])).toEqual(["Built the billing system in Python.", "Led a team of 6.", "Ran the office party."]);
    expect(citedIds(r.doc.content![5])[0]).toEqual(["Built the billing system in Python.", ["S1.P2"]]);
    expect(changeDetail(r)).toBe("Changed 1 line.");
  });

  it("rewrites a top-level paragraph, keeping its attrs", () => {
    const base = resume();
    base.content![2] = { ...base.content![2], attrs: { textAlign: "left" } };
    const r = planWorkflowChange(base, { ops: [linesOp(line({ id: "L1", sectionId: "s-sum", heading: "Summary", original: "Engineer with a decade of work.", proposed: "Billing engineer with a decade of work." }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.content![2]).toEqual({ type: "paragraph", attrs: { textAlign: "left" }, content: [text("Billing engineer with a decade of work.")] });
  });

  it("leads: moves a list item to the top of its list, rewriting it when the text changed", () => {
    const r = planWorkflowChange(resume(), { ops: [linesOp(line({ id: "L1", action: "lead", original: "Led a team of 6.", proposed: "Led a billing team of 6.", evidence: [support("S1.P3")] }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(texts(r.doc.content![5])).toEqual(["Led a billing team of 6.", "Built the billing system.", "Ran the office party."]);
    expect(r.lines![0].detail).toBe("Moved to the top and rewritten");
  });

  it("won't lead a paragraph outside a list: moved to the top of its section it could land under another employer's header", () => {
    const jobs = () => doc(h("Experience", "s-exp"), p(text("Acme Corp - Engineer, 2020-2024")), ul("Built A"), p(text("Beta Inc - Engineer, 2017-2020")), p(text("Led the Beta migration.")));
    const r = planWorkflowChange(jobs(), { ops: [linesOp(line({ id: "L1", action: "lead", original: "Led the Beta migration.", proposed: "Led the Beta migration." }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.doc).toEqual(jobs());
    expect(r.lines![0]).toEqual({ lineId: "L1", result: "skipped", detail: LINE_NOT_IN_LIST });
    expect(r.applied).toBe(0);
  });

  it("won't trim a paragraph a list follows (a job's header line), which would leave its bullets under the job above", () => {
    const jobs = () => doc(h("Experience", "s-exp"), p(text("Acme Corp - Engineer")), ul("Built A"), p(text("Beta Inc - Engineer")), ul("Led the Beta migration."));
    const r = planWorkflowChange(jobs(), { ops: [linesOp(line({ id: "L1", action: "trim", original: "Beta Inc - Engineer" }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.doc).toEqual(jobs());
    expect(r.lines![0]).toMatchObject({ result: "skipped", detail: LINE_HAS_ITEMS });
  });

  it("changes the repeat of a duplicated line the run meant, and skips it when the count of repeats changed", () => {
    const jobs = () => doc(h("Experience", "s-exp"), p(text("Acme")), ul("Led a team of 5 engineers"), p(text("Beta")), ul("Led a team of 5 engineers"));
    const beta = line({ id: "L1", original: "Led a team of 5 engineers", proposed: "Led a team of 5 engineers on Beta billing", occurrence: 1, occurrences: 2 });
    const r = planWorkflowChange(jobs(), { ops: [linesOp(beta)] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect([texts(r.doc.content![2]), texts(r.doc.content![4])]).toEqual([["Led a team of 5 engineers"], ["Led a team of 5 engineers on Beta billing"]]);
    // Both, listed in reverse document order: each still lands on its own repeat.
    const acme = line({ id: "L2", original: "Led a team of 5 engineers", proposed: "Led a team of 5 engineers on Acme search", occurrence: 0, occurrences: 2 });
    const both = planWorkflowChange(jobs(), { ops: [linesOp(beta, acme)] }, deps());
    if (!both.ok) throw new Error(both.error);
    expect([texts(both.doc.content![2]), texts(both.doc.content![4])]).toEqual([["Led a team of 5 engineers on Acme search"], ["Led a team of 5 engineers on Beta billing"]]);
    // One repeat was removed since the run: which one it meant can't be told, so it is skipped.
    const edited = jobs();
    edited.content = edited.content!.slice(0, 4);
    const gone = planWorkflowChange(edited, { ops: [linesOp(beta)] }, deps());
    if (!gone.ok) throw new Error(gone.error);
    expect(gone.lines![0]).toMatchObject({ result: "skipped", detail: LINE_GONE });
  });

  it("skips a line whose section heading is kept but whose lines were deleted, never trimming the same bullet under another job", () => {
    // Job A's bullets were deleted since the run; its heading remains. Job B has the same generic bullet.
    const jobs = () => doc(h("Job A", "s-a"), h("Job B", "s-b"), ul("Worked with teams"));
    const r = planWorkflowChange(jobs(), { ops: [linesOp(line({ id: "L1", action: "trim", sectionId: "s-a", heading: "Job A", original: "Worked with teams", occurrence: 0, occurrences: 1 }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.doc).toEqual(jobs());
    expect(r.lines![0]).toEqual({ lineId: "L1", result: "skipped", detail: LINE_GONE });
  });

  it("trims the last item and removes the list it leaves empty", () => {
    const r = planWorkflowChange(resume(), { ops: [linesOp(line({ id: "L1", action: "trim", sectionId: "s-skills", heading: "Skills", original: "Python" }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.content!.at(-1)).toEqual(h("Skills", "s-skills"));
    expect(r.doc.content).toHaveLength(7);
  });

  it("skips (and reports) a line edited since the run, and applies the rest", () => {
    const base = resume();
    const r = planWorkflowChange(
      base,
      {
        ops: [
          linesOp(
            line({ id: "L1", original: "Built the billing system!", proposed: "Built it." }),
            line({ id: "L2", action: "trim", original: "Ran the office party." }),
          ),
        ],
      },
      deps(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.applied).toBe(1);
    expect(r.lines).toEqual([
      { lineId: "L1", result: "skipped", detail: LINE_GONE },
      { lineId: "L2", result: "accepted", detail: "Trimmed" },
    ]);
    expect(changeDetail(r)).toBe("Changed 1 line; 1 skipped (edited since the run).");
    // Pure: the input is untouched.
    expect(texts(base.content![5])).toHaveLength(3);
  });

  it("applies several lines in one list against the document as it was", () => {
    const r = planWorkflowChange(
      resume(),
      {
        ops: [
          linesOp(
            line({ id: "L1", action: "lead", original: "Led a team of 6.", proposed: "Led a team of 6." }),
            line({ id: "L2", action: "lead", original: "Ran the office party.", proposed: "Ran the office party." }),
            line({ id: "L3", original: "Built the billing system.", proposed: "Built billing." }),
          ),
        ],
      },
      deps(),
    );
    if (!r.ok) throw new Error(r.error);
    // The first lead listed ends on top.
    expect(texts(r.doc.content![5])).toEqual(["Led a team of 6.", "Ran the office party.", "Built billing."]);
    expect(r.applied).toBe(3);
  });

  it("trims every item of a list, and the list goes", () => {
    const r = planWorkflowChange(
      resume(),
      { ops: [linesOp(...["Built the billing system.", "Led a team of 6.", "Ran the office party."].map((o, i) => line({ id: `L${i + 1}`, action: "trim", original: o })))] },
      deps(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.content!.map((n) => n.type)).toEqual(["paragraph", "heading", "paragraph", "paragraph", "heading", "heading", "bulletList"]);
  });

  it("won't trim a list item's opening line when sub-items hang under it", () => {
    const nested = doc(h("Experience", "s-exp"), { type: "bulletList", content: [{ type: "listItem", content: [p(text("Acme Corp")), ul("Built things.")] }] });
    const r = planWorkflowChange(nested, { ops: [linesOp(line({ id: "L1", action: "trim", original: "Acme Corp" }))] }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.applied).toBe(0);
    expect(r.lines![0]).toEqual({ lineId: "L1", result: "skipped", detail: LINE_HAS_ITEMS });
    // A nested line is trimmed, and its emptied sub-list goes with it.
    const r2 = planWorkflowChange(nested, { ops: [linesOp(line({ id: "L1", action: "trim", original: "Built things." }))] }, deps());
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.doc.content![1].content![0].content).toEqual([p(text("Acme Corp"))]);
  });

  it("an empty doc after trimming keeps one empty paragraph", () => {
    const r = planWorkflowChange(doc(p(text("Only line."))), { ops: [linesOp(line({ id: "L1", action: "trim", sectionId: null, original: "Only line." }))] }, deps());
    expect(r.ok && r.doc.content).toEqual([{ type: "paragraph" }]);
  });
});

describe("applyWorkflowChange: replace_lines", () => {
  // One undo step stays the caller's concern: this checks the order of save, snapshot, dispatch and the second save.
  const fakeEditor = (calls: string[]) =>
    ({
      isDestroyed: false,
      getJSON: () => doc(h("Experience", "s-exp"), ul("Built the billing system.")),
      state: { doc: { content: { size: 10 } }, schema: { nodeFromJSON: (d: PMNode) => ({ content: d.content }) }, tr: { replaceWith: () => ({ scrollIntoView: () => "tr" }) } },
      view: { dispatch: () => calls.push("dispatch") },
    }) as unknown as Parameters<typeof applyWorkflowChange>[0];
  const linesChange = () => ({ id: "write", title: "Tailored lines", summary: "", basisUpdatedAt: "", snapshotReason: "Before", ops: [linesOp(line({ id: "L1", original: "Built the billing system.", proposed: "Built billing." }))] });
  const saving = (calls: string[], saved: boolean[] = []) => ({
    ...deps(),
    ensureSaved: async () => {
      calls.push("save");
      return "doc-1";
    },
    snapshot: async () => {
      calls.push("snapshot");
    },
    isSaved: () => saved.shift() ?? true,
  });

  it("saves, snapshots, dispatches once, then saves again so the resumed run reads the applied text", async () => {
    const calls: string[] = [];
    const out = await applyWorkflowChange(fakeEditor(calls), linesChange(), saving(calls));
    expect(calls).toEqual(["save", "snapshot", "dispatch", "save"]);
    expect(out).toEqual({ result: "applied", detail: "Changed 1 line.", typeKey: null, lines: [{ lineId: "L1", result: "accepted", detail: "Rewritten" }] });
  });

  it("flags the result unsaved when the save after the lines conflicted or failed, so nothing posts a result the stored document lacks", async () => {
    const calls: string[] = [];
    const out = await applyWorkflowChange(fakeEditor(calls), linesChange(), saving(calls, [true, false]));
    expect(calls).toEqual(["save", "snapshot", "dispatch", "save"]);
    expect(out).toMatchObject({ result: "applied", unsaved: true });
  });

  it("refuses to apply lines over a save that already failed", async () => {
    const calls: string[] = [];
    const out = await applyWorkflowChange(fakeEditor(calls), linesChange(), saving(calls, [false]));
    expect(calls).toEqual(["save"]);
    expect(out).toEqual({ result: null, detail: SAVE_FIRST, typeKey: null });
  });
});
