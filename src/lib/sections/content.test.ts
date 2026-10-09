import { describe, expect, it } from "vitest";
import { sectionBlocksFromMarkdown, stripCitationMarkers } from "./content";

describe("sectionBlocksFromMarkdown", () => {
  it("joins single newlines by default and keeps them as line breaks with lineBreaks", () => {
    const md = "**To:** Council\n**From:** Staff\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(sectionBlocksFromMarkdown(md, 2)[0].content?.map((c) => c.type)).toEqual(["text", "text", "text", "text"]);
    const kept = sectionBlocksFromMarkdown(md, 2, { lineBreaks: true });
    expect(kept[0].content?.map((c) => c.type)).toEqual(["text", "text", "hardBreak", "text", "text"]);
    expect(kept[1].type).toBe("table");
  });

  it("pushes generated headings below the section level", () => {
    const blocks = sectionBlocksFromMarkdown("# Top\n\nText\n\n## Sub", 2);
    expect(blocks.map((b) => [b.type, b.attrs?.level])).toEqual([
      ["heading", 3],
      ["paragraph", undefined],
      ["heading", 3],
    ]);
  });

  it("turns a heading that can't go below a level-3 section into a bold paragraph", () => {
    const [first] = sectionBlocksFromMarkdown("### Detail", 3);
    expect(first.type).toBe("paragraph");
    expect(first.content?.[0]).toMatchObject({ text: "Detail", marks: [{ type: "bold" }] });
  });

  it("strips citation markers", () => {
    expect(stripCitationMarkers("Costs rose [[p:S1234abcd.P3]] sharply.")).toBe("Costs rose sharply.");
    expect(stripCitationMarkers("Growth hit 12% [[p:S1234abcd.P3|Growth was 12% [3] in 2025]].")).toBe("Growth hit 12%.");
    expect(stripCitationMarkers("Open [[p:S1234abcd.P3|never closed\nNext.")).toBe("Open\nNext.");
    const blocks = sectionBlocksFromMarkdown("Costs rose [[p:S1.P1]].", 2);
    expect(JSON.stringify(blocks)).not.toContain("[[p:");
  });

  it("turns verified markers into citation marks when given the report", () => {
    const id = "S1a2b3c4d.P3";
    const citations = { kept: 1, dropped: [], passages: { [id]: { passageId: id, sourceId: "src", sourceTitle: "Report", page: 1, quote: null, excerpt: "Costs rose." } } };
    const [p] = sectionBlocksFromMarkdown(`Intro. Costs rose sharply.[[p:${id}]]`, 2, { citations });
    expect(JSON.stringify(p)).not.toContain("[[p:");
    expect(p.content).toEqual([
      { type: "text", text: "Intro. " },
      { type: "text", text: "Costs rose sharply.", marks: [{ type: "citation", attrs: { kind: "passage", passageId: id, sourceId: "src", dataTableId: null, quote: null, verified: true } }] },
    ]);
    // Without a report (an older server), markers are stripped and nothing is marked.
    expect(JSON.stringify(sectionBlocksFromMarkdown(`Costs rose.[[p:${id}]]`, 2, { citations: null }))).not.toContain("citation");
  });

  it("returns one empty paragraph for empty input", () => {
    expect(sectionBlocksFromMarkdown("   ", 2)).toEqual([{ type: "paragraph" }]);
  });
});
