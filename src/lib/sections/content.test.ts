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
    const blocks = sectionBlocksFromMarkdown("Costs rose [[p:S1.P1]].", 2);
    expect(JSON.stringify(blocks)).not.toContain("[[p:");
  });

  it("returns one empty paragraph for empty input", () => {
    expect(sectionBlocksFromMarkdown("   ", 2)).toEqual([{ type: "paragraph" }]);
  });
});
