import { describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/documents/sections";
import { NO_HOME_HEADING, type RestructurePlan, type RestructureRow } from "./contract";
import { applyRestructurePlan, blockHash, blockHashes, restructureChunks, type TargetSection } from "./restructure";

const h = (text: string, level = 2, attrs: Record<string, unknown> = {}): PMNode => ({ type: "heading", attrs: { level, sectionId: `id_${text.replace(/\W/g, "")}`, specKey: null, ...attrs }, content: [{ type: "text", text }] });
const p = (text: string): PMNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content });

const SECTIONS: TargetSection[] = [
  { key: "summary", heading: "Summary", order: 1, level: 2 },
  { key: "approach", heading: "Approach", order: 2, level: 2 },
  { key: "budget", heading: "Budget", order: 3, level: 2, scaffold: "Total:" },
];

function plan(d: PMNode, targets: Record<number, string | null>): RestructurePlan {
  const rows: RestructureRow[] = restructureChunks(d).map((c, i) => ({ id: `R${i + 1}`, from: c.from, to: c.to, heading: c.heading, excerpt: c.excerpt, target: targets[i] ?? null, reason: "" }));
  return { targetType: "proposal", targetTitle: "Proposal", mode: "merge", basisUpdatedAt: "2026-10-08T00:00:00.000Z", blockHashes: blockHashes(d), rows, gaps: [] };
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

  it("hashes blocks by type and text", () => {
    expect(blockHash(p("a"))).toBe(blockHash(p("a")));
    expect(blockHash(p("a"))).not.toBe(blockHash(p("b")));
    expect(blockHash(p("a"))).not.toBe(blockHash(h("a")));
  });
});

describe("applyRestructurePlan", () => {
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
