import { describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/documents/sections";
import { NO_HOME_HEADING, type RestructurePlan, type RestructureRow } from "./contract";
import { applyRestructurePlan, blockHash, blockHashes, droppedWarning, restructureChunks, type TargetSection } from "./restructure";

const h = (text: string, level = 2, attrs: Record<string, unknown> = {}): PMNode => ({ type: "heading", attrs: { level, sectionId: `id_${text.replace(/\W/g, "")}`, specKey: null, ...attrs }, content: [{ type: "text", text }] });
const p = (text: string): PMNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content });

const SECTIONS: TargetSection[] = [
  { key: "summary", heading: "Summary", order: 1, level: 2 },
  { key: "approach", heading: "Approach", order: 2, level: 2 },
  { key: "budget", heading: "Budget", order: 3, level: 2, scaffold: "Total:" },
];

/** A plan as restructure.plan makes it: heading-only parts dropped, the rest numbered in order (targets by that number). */
function plan(d: PMNode, targets: Record<number, string | null>): RestructurePlan {
  const chunks = restructureChunks(d);
  const rows: RestructureRow[] = chunks
    .filter((c) => !c.headingOnly)
    .map((c, i) => ({ id: `R${i + 1}`, from: c.from, to: c.to, heading: c.heading, excerpt: c.excerpt, target: targets[i] ?? null, reason: "" }));
  const dropped = chunks.filter((c) => c.headingOnly).map((c) => ({ index: c.from, heading: c.heading!, level: c.level! }));
  return { targetType: "proposal", targetTitle: "Proposal", mode: "merge", basisUpdatedAt: "2026-10-08T00:00:00.000Z", blockHashes: blockHashes(d), rows, gaps: [], dropped };
}

/** Every text node's text, as a sorted multiset (headings created for target sections excluded). */
function texts(n: PMNode, skip: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const walk = (x: PMNode) => {
    if (x.type === "text" && x.text && !skip.has(x.text)) out.push(x.text);
    (x.content ?? []).forEach(walk);
  };
  walk(n);
  return out.sort();
}

let n = 0;
const newId = () => `new_${++n}`;

const SAMPLE = doc(
  p("Opening words before any heading."),
  h("Background"),
  p("Why we are here."),
  h("Detail", 3),
  p("A nested detail."),
  h("Our approach"),
  p("We will do the work."),
  h("Summary"),
  p("In short: do it."),
  h("Appendix"),
  p("Extra material."),
);

describe("restructureChunks", () => {
  it("splits at headings up to level 3, with the preamble as its own part", () => {
    const chunks = restructureChunks(SAMPLE);
    expect(chunks.map((c) => [c.from, c.to, c.heading])).toEqual([
      [0, 0, null],
      [1, 2, "Background"],
      [3, 4, "Detail"],
      [5, 6, "Our approach"],
      [7, 8, "Summary"],
      [9, 10, "Appendix"],
    ]);
    expect(chunks[1].text).toBe("Why we are here.");
  });

  it("skips a blank preamble and keeps level-4 headings in their part", () => {
    const chunks = restructureChunks(doc({ type: "paragraph" }, h("A"), h("Deep", 4), p("x")));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ from: 1, to: 3, heading: "A" });
  });

  it("marks a part that is only a heading (blank paragraphs at most), but not one with a table, sub-heading or text", () => {
    const table: PMNode = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }] };
    const chunks = restructureChunks(doc(h("Empty"), { type: "paragraph" }, h("Kept", 3), p("x"), h("Grid"), table, h("Parent"), h("Deep", 4), p("y")));
    expect(chunks.map((c) => [c.heading, c.headingOnly])).toEqual([
      ["Empty", true],
      ["Kept", false],
      ["Grid", false],
      ["Parent", false],
    ]);
  });

  it("hashes blocks by type and text", () => {
    expect(blockHash(p("a"))).toBe(blockHash(p("a")));
    expect(blockHash(p("a"))).not.toBe(blockHash(p("b")));
    expect(blockHash(p("a"))).not.toBe(blockHash(h("a")));
  });
});

describe("applyRestructurePlan", () => {
  it("never drops text but the dropped headings: the multiset of text nodes is otherwise preserved", () => {
    // An earlier restructure's level-2 headings over kept level-3 headings: the level-2 ones are heading-only.
    const again = doc(h("Summary"), h("Background", 3), p("Why we are here."), h("Approach"), h("Our approach", 3), p("We will do the work."), h("Budget"), p("Total: 10."));
    const pl = plan(again, { 0: "summary", 1: "approach", 2: "budget" });
    expect(pl.dropped).toEqual([
      { index: 0, heading: "Summary", level: 2 },
      { index: 3, heading: "Approach", level: 2 },
    ]);
    const r = applyRestructurePlan(again, pl, SECTIONS, newId);
    expect(r).toMatchObject({ drift: false, removed: 2 });
    const created = new Set(["Summary", "Approach"]);
    const droppedTexts = new Set(pl.dropped!.map((x) => x.heading));
    // Exactly the dropped headings are gone; the outline's own headings are created anew.
    expect(texts(r.doc, created)).toEqual(texts(again, droppedTexts));
    expect(r.doc.content!.filter((x) => x.content?.[0]?.text === NO_HOME_HEADING)).toHaveLength(0);
  });

  it("passes a dropped heading's sectionId on to the target section with the same heading", () => {
    const again = doc(h("Summary"), h("Background", 3), p("Why."), h("Approach"), h("Budget"), p("Total: 10."));
    const pl = plan(again, { 0: "summary", 1: "budget" });
    const out = applyRestructurePlan(again, pl, SECTIONS, newId).doc.content!;
    // Summary is filled by Background's row; Approach is added empty; both keep the old heading's id.
    expect(out.find((x) => x.attrs?.specKey === "summary")?.attrs?.sectionId).toBe("id_Summary");
    expect(out.find((x) => x.attrs?.specKey === "approach")?.attrs?.sectionId).toBe("id_Approach");
    expect(out.filter((x) => x.type === "heading").map((x) => x.content?.[0]?.text)).toEqual(["Summary", "Background", "Approach", "Budget"]);
  });

  it("reads a plan stored before Phase 8 (no dropped): heading-only rows are moved as before", () => {
    const again = doc(h("Summary"), h("Background", 3), p("Why."));
    const rows: RestructureRow[] = restructureChunks(again).map((c, i) => ({ id: `R${i + 1}`, from: c.from, to: c.to, heading: c.heading, excerpt: c.excerpt, target: "summary", reason: "" }));
    const old: RestructurePlan = { targetType: "proposal", targetTitle: "Proposal", mode: "merge", basisUpdatedAt: "", blockHashes: blockHashes(again), rows, gaps: [] };
    const r = applyRestructurePlan(again, old, SECTIONS, newId);
    expect(r).toMatchObject({ drift: false, removed: 0 });
    expect(texts(r.doc, new Set(["Approach", "Budget", "Total:"]))).toEqual(texts(again));
  });

  it("ignores a dropped entry that points at a row or at text", () => {
    const d = doc(h("Summary"), p("Kept."));
    const pl = { ...plan(d, { 0: "summary" }), dropped: [{ index: 0, heading: "Summary", level: 2 }, { index: 1, heading: "Kept.", level: 2 }] };
    expect(texts(applyRestructurePlan(d, pl, SECTIONS, newId).doc)).toContain("Kept.");
  });

  it("words the warning", () => {
    expect(droppedWarning(undefined)).toBe("");
    expect(droppedWarning([{ index: 0, heading: "Summary", level: 2 }, { index: 3, heading: "Approach", level: 2 }])).toBe("These headings hold no text of their own and will be removed: “Summary”, “Approach”.");
  });

  it("never drops text: the multiset of text nodes is preserved", () => {
    const pl = plan(SAMPLE, { 0: null, 1: "summary", 2: "approach", 3: "approach", 4: "summary", 5: null });
    const r = applyRestructurePlan(SAMPLE, pl, SECTIONS, newId);
    expect(r.drift).toBe(false);
    const created = new Set(["Approach", "Budget", "Total:", NO_HOME_HEADING]);
    expect(texts(r.doc, created)).toEqual(texts(SAMPLE));
    expect(r).toMatchObject({ moved: 4, added: 1, noHome: 1 });
  });

  it("orders sections by the outline, reuses a matching heading, and nests other headings one level down", () => {
    const pl = plan(SAMPLE, { 0: null, 1: "summary", 2: "approach", 3: "approach", 4: "summary", 5: null });
    const out = applyRestructurePlan(SAMPLE, pl, SECTIONS, newId).doc.content!;
    const headings = out.filter((x) => x.type === "heading").map((x) => [x.content?.[0]?.text, x.attrs?.level, x.attrs?.specKey]);
    expect(headings).toEqual([
      ["Summary", 2, "summary"],
      ["Background", 3, null],
      ["Approach", 2, "approach"],
      ["Detail", 3, null],
      ["Our approach", 3, null],
      ["Budget", 2, "budget"],
      [NO_HOME_HEADING, 2, null],
      ["Appendix", 3, null],
    ]);
    // The matching heading keeps its sectionId; Background's body follows Summary's heading in document order.
    const summary = out.find((x) => x.attrs?.specKey === "summary")!;
    expect(summary.attrs?.sectionId).toBe("id_Summary");
    expect(out[0].content?.[0]?.text).toBe("Opening words before any heading.");
    const idx = (t: string) => out.findIndex((x) => x.content?.[0]?.text === t);
    expect(idx("Why we are here.")).toBeLessThan(idx("In short: do it."));
    // Budget had no rows: added with its scaffold.
    expect(out[idx("Budget") + 1].type).toBe("paragraph");
  });

  it("matches headings ignoring case and punctuation", () => {
    const d = doc(h("SUMMARY:"), p("text"));
    const r = applyRestructurePlan(d, plan(d, { 0: "summary" }), SECTIONS, newId);
    expect(r.doc.content![0]).toMatchObject({ attrs: { specKey: "summary", sectionId: "id_SUMMARY" } });
  });

  it("moves a preamble with a target into that section's body", () => {
    const d = doc(p("Lead text."), h("Other"), p("More."));
    const r = applyRestructurePlan(d, plan(d, { 0: "approach", 1: null }), SECTIONS, newId);
    const out = r.doc.content!;
    const at = out.findIndex((x) => x.attrs?.specKey === "approach");
    expect(out[at + 1].content?.[0]?.text).toBe("Lead text.");
    expect(out.some((x) => x.content?.[0]?.text === NO_HOME_HEADING)).toBe(true);
  });

  it("treats a target outside the outline as no home", () => {
    const d = doc(h("Odd"), p("Odd body."));
    const r = applyRestructurePlan(d, plan(d, { 0: "not-a-section" }), SECTIONS, newId);
    expect(r.noHome).toBe(1);
    expect(texts(r.doc)).toContain("Odd body.");
  });

  it("refuses on drift: a changed block or a changed block count", () => {
    const pl = plan(SAMPLE, {});
    const edited = doc(...SAMPLE.content!.map((x, i) => (i === 2 ? p("Edited.") : x)));
    expect(applyRestructurePlan(edited, pl, SECTIONS, newId)).toMatchObject({ drift: true, doc: edited });
    expect(applyRestructurePlan(doc(...SAMPLE.content!, p("new")), pl, SECTIONS, newId).drift).toBe(true);
  });

  it("does not modify its input", () => {
    const before = JSON.stringify(SAMPLE);
    applyRestructurePlan(SAMPLE, plan(SAMPLE, { 1: "summary", 4: "summary" }), SECTIONS, newId);
    expect(JSON.stringify(SAMPLE)).toBe(before);
  });
});

describe("applyRestructurePlan and citations", () => {
  it("keeps citation marks on text it moves verbatim", () => {
    const cite = { type: "citation", attrs: { kind: "passage", passageId: "S1a2b3c4d.P7", sourceId: "src-1", dataTableId: null, quote: "rose", verified: true } };
    const cited: PMNode = { type: "paragraph", content: [{ type: "text", text: "Demand rose.", marks: [cite] }, { type: "text", text: " Plain." }] };
    const d = doc(h("Background"), cited, h("Plan"), p("Next steps."));
    const r = applyRestructurePlan(d, plan(d, { 0: "approach", 1: "summary" }), SECTIONS, newId);
    expect(r.drift).toBe(false);
    const moved = r.doc.content!.find((x) => x.content?.[0]?.text === "Demand rose.")!;
    expect(moved.content![0].marks).toEqual([cite]);
    expect(moved.content![1]).toEqual({ type: "text", text: " Plain." });
  });
});
