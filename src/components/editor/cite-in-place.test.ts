import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { CitationReport } from "@/lib/citations/contract";
import { alignLetters, placeCitations } from "./cite-in-place";
import { documentExtensions } from "./extensions";
import { sectionBodyRange } from "./tracked-range";

const schema = getSchema(documentExtensions());
const ID = "S1a2b3c4d.P1";
const report: CitationReport = {
  kept: 1,
  dropped: [],
  passages: { [ID]: { passageId: ID, sourceId: "src-1", sourceTitle: "Q3 Report", page: 4, quote: null, excerpt: "Demand rose 12% in 2025." } },
};
const tableCite = { type: "citation", attrs: { kind: "table", passageId: null, sourceId: "s1", dataTableId: "t1", quote: null, verified: true } };
const cell = (type: string, text: string) => ({ type, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function section() {
  return PMNodeClass.fromJSON(schema, {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2, sectionId: "s_a" }, content: [{ type: "text", text: "Findings" }] },
      { type: "paragraph", content: [{ type: "text", text: "Demand rose 12% in 2025. " }, { type: "text", text: "Prices held", marks: [{ type: "underline" }] }, { type: "text", text: "." }] },
      {
        type: "table",
        attrs: { dataTableId: "t1", sourceId: "s1" },
        content: [
          { type: "tableRow", content: [cell("tableHeader", "Region"), cell("tableHeader", "Sales")] },
          { type: "tableRow", content: [cell("tableCell", "North"), cell("tableCell", "10")] },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Source: " },
          { type: "text", text: "Prices 2025", marks: [{ type: "link", attrs: { href: "/library?source=s1" } }, tableCite] },
          { type: "text", text: " — Pricing.xlsx" },
        ],
      },
      { type: "heading", attrs: { level: 2, sectionId: "s_b" }, content: [{ type: "text", text: "Next" }] },
    ],
  });
}

/** Applies the placed citations as the hook does and returns the new document. */
function apply(doc: PMNodeClass, markdown: string) {
  const range = sectionBodyRange(doc, "s_a")!;
  const placed = placeCitations(doc, range, markdown, report);
  if (!placed) return null;
  const state = EditorState.create({ schema, doc });
  const tr = state.tr;
  for (const c of placed) tr.addMark(c.from, c.to, schema.marks.citation.create(c.attrs));
  return { placed, doc: tr.doc };
}

describe("placeCitations", () => {
  // The body as Cite sources sends it: every cell its own paragraph, the table citation left out.
  const flat = `Demand rose 12% in 2025.[[p:${ID}]] Prices held.\n\nRegion\n\nSales\n\nNorth\n\n10\n\nSource: Prices 2025 — Pricing.xlsx`;
  const gfm = `Demand rose 12% in 2025.[[p:${ID}]] Prices held.\n\n| Region | Sales |\n| --- | --- |\n| North | 10 |\n\nSource: Prices 2025 — Pricing.xlsx`;

  for (const [name, reply] of [["paragraph-per-cell", flat], ["GFM table", gfm]] as const) {
    it(`adds the citation to the existing text and keeps the table, link, table citation and formatting (${name} reply)`, () => {
      const before = section();
      const out = apply(before, reply)!;
      expect(out.placed).toEqual([{ from: expect.any(Number), to: expect.any(Number), attrs: expect.objectContaining({ kind: "passage", passageId: ID, verified: true }) }]);
      expect(out.doc.textBetween(out.placed[0].from, out.placed[0].to)).toBe("Demand rose 12% in 2025.");
      // Everything but the new mark is as it was.
      const json = JSON.stringify(out.doc.toJSON());
      expect(json).toContain('"dataTableId":"t1"');
      expect(json).toContain('"kind":"table"');
      expect(json).toContain('"href":"/library?source=s1"');
      expect(json).toContain('"type":"underline"');
      expect(out.doc.childCount).toBe(before.childCount);
      expect(out.doc.child(2).type.name).toBe("table");
    });
  }

  it("tolerates a small edit elsewhere, and refuses when the words no longer line up", () => {
    const edited = apply(section(), flat.replace("Prices held.", "Prices held firm."))!;
    expect(edited.placed).toHaveLength(1);
    expect(apply(section(), `Something else entirely, nothing in common with the section at all.[[p:${ID}]]`)).toBeNull();
  });

  it("adds nothing where the same passage is already cited", () => {
    const once = apply(section(), flat)!;
    const range = sectionBodyRange(once.doc, "s_a")!;
    expect(placeCitations(once.doc, range, flat, report)).toEqual([]);
  });
});

describe("alignLetters", () => {
  it("maps equal letters one to one and skips an inserted run", () => {
    expect([...alignLetters("abcdef", "abcdef")!]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...alignLetters("abxc", "abc")!]).toEqual([0, 1, -1, 2]);
    expect(alignLetters("abcdefghijklmnop", "zyxwvutsrqponmlkjihg".repeat(5))).toBeNull();
  });
});
