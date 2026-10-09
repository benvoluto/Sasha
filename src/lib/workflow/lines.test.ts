import { describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/documents/sections";
import { documentLines, documentSections, findLine, normalizeLine } from "./lines";

const p = (text: string): PMNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (text: string, sectionId: string): PMNode => ({ type: "heading", attrs: { level: 2, sectionId, specKey: null }, content: [{ type: "text", text }] });
const doc: PMNode = {
  type: "doc",
  content: [
    p("Jane Doe"),
    h("Experience", "exp"),
    { type: "bulletList", content: [{ type: "listItem", content: [p("Led a team of 5")] }, { type: "listItem", content: [p("Shipped “Atlas” on time")] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("in a table")] }] }] },
    h("Skills", "sk"),
    p("Led a team of 5"),
    { type: "paragraph" },
  ],
};

describe("documentLines", () => {
  it("lists paragraphs with their section, in lists or not, and skips tables and empty paragraphs", () => {
    const lines = documentLines(doc);
    expect(lines.map((l) => [l.ref, l.sectionId, l.text, l.inList])).toEqual([
      ["D1", null, "Jane Doe", false],
      ["D2", "exp", "Led a team of 5", true],
      ["D3", "exp", "Shipped “Atlas” on time", true],
      ["D4", "sk", "Led a team of 5", false],
    ]);
    expect(lines[1].path).toEqual([2, 0, 0]);
  });
});

describe("findLine", () => {
  const lines = documentLines(doc);
  const sections = documentSections(doc);
  it("finds the line in its section by normalized text", () => {
    expect(findLine(lines, { sectionId: "sk", original: "Led  a team of 5" }, { sections })?.ref).toBe("D4");
    expect(findLine(lines, { sectionId: "exp", original: 'Shipped "Atlas" on time' }, { sections })?.ref).toBe("D3");
  });
  it("returns null when the line was edited, and outside a missing section only for a unique match", () => {
    expect(findLine(lines, { sectionId: "exp", original: "Led a team of 6" }, { sections })).toBeNull();
    expect(findLine(lines, { sectionId: "gone", original: "Led a team of 5" }, { sections })).toBeNull();
    expect(findLine(lines, { sectionId: "gone", original: "Jane Doe" }, { sections })?.ref).toBe("D1");
    expect(findLine(lines, { sectionId: "exp", original: "Led a team of 5" }, { sections, used: new Set(["D2"]) })).toBeNull();
  });
  it("never takes an identical line from another section when the target's heading is kept but its lines are gone", () => {
    // Job A's bullets were all deleted; its heading remains. Job B holds the same generic bullet.
    const left: PMNode = { type: "doc", content: [h("Job A", "a"), h("Job B", "b"), p("Worked with teams")] };
    const target = { sectionId: "a", original: "Worked with teams", occurrence: 0, occurrences: 1 };
    expect(findLine(documentLines(left), target, { sections: documentSections(left) })).toBeNull();
    // With Job A's heading gone too, the one remaining match is taken.
    const gone: PMNode = { type: "doc", content: [h("Job B", "b"), p("Worked with teams")] };
    expect(findLine(documentLines(gone), target, { sections: documentSections(gone) })?.sectionId).toBe("b");
    expect([...documentSections(left)]).toEqual([null, "a", "b"]);
  });
  it("normalizes quotes and spaces", () => expect(normalizeLine(" a  “b” ")).toBe('a "b"'));
});
