import { describe, expect, it } from "vitest";
import { docFromOutline, docText, isEmptyDoc, listSections, wordCount, type PMNode } from "./sections";

const h = (level: number, text: string, sectionId: string, specKey?: string): PMNode => ({
  type: "heading",
  attrs: { level, sectionId, specKey: specKey ?? null },
  content: [{ type: "text", text }],
});
const p = (text: string): PMNode => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("sections", () => {
  const doc: PMNode = {
    type: "doc",
    content: [p("Preamble."), h(2, "Reason", "s1", "reason"), p("Because."), h(3, "Detail", "s2"), p("More."), h(2, "Budget", "s3"), p("Money.")],
  };

  it("lists headings with their bodies up to the next heading at the same or higher level", () => {
    const s = listSections(doc);
    expect(s.map((x) => x.heading)).toEqual(["Reason", "Detail", "Budget"]);
    expect(s[0]).toMatchObject({ sectionId: "s1", specKey: "reason", level: 2, bodyText: "Because.\nDetail\nMore." });
    expect(s[1].bodyText).toBe("More.");
    expect(s[2].bodyText).toBe("Money.");
  });

  it("extracts plain text and counts words", () => {
    expect(docText(doc)).toContain("Reason\nBecause.");
    expect(wordCount("  one two\nthree ")).toBe(3);
    expect(isEmptyDoc({ type: "doc", content: [{ type: "paragraph" }] })).toBe(true);
    expect(isEmptyDoc(doc)).toBe(false);
  });

  it("builds an outline document with stable ids and spec keys", () => {
    let n = 0;
    const out = docFromOutline([{ key: "a", heading: "A" }, { key: "b", heading: "B" }], () => `id${++n}`);
    expect(listSections(out).map((s) => [s.sectionId, s.specKey, s.heading])).toEqual([["id1", "a", "A"], ["id2", "b", "B"]]);
  });
});
