import { describe, expect, it } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import { Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { mapRange, sectionBodyRange, sectionHeadingIndexAt, type TextRange } from "./tracked-range";

// <p>Hello brave world</p>: "brave" spans 7..12.
const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Hello brave world")])]);
const brave: TextRange = { from: 7, to: 12, text: "brave" };

describe("mapRange", () => {
  it("returns the range unchanged when nothing happened", () => {
    const tr = new Transform(doc);
    expect(mapRange(tr.mapping, tr.doc, brave)).toEqual({ from: 7, to: 12 });
  });

  it("follows the range when text is inserted before it, and keeps edge insertions outside", () => {
    const tr = new Transform(doc).insert(1, schema.text("Oh, ")).insert(16, schema.text("!"));
    // "Oh, Hello brave! world": brave moved by 4; the "!" typed at its end is not included.
    expect(mapRange(tr.mapping, tr.doc, brave)).toEqual({ from: 11, to: 16 });
  });

  it("gives up when the range was deleted", () => {
    const tr = new Transform(doc).delete(5, 14);
    expect(mapRange(tr.mapping, tr.doc, brave)).toBeNull();
  });

  it("gives up when the text inside the range changed", () => {
    const tr = new Transform(doc).insert(9, schema.text("XX"));
    expect(mapRange(tr.mapping, tr.doc, brave)).toBeNull();
  });
});

describe("sectionBodyRange", () => {
  const s = new Schema({
    nodes: {
      doc: { content: "block+" },
      text: { group: "inline" },
      paragraph: { group: "block", content: "inline*" },
      heading: { group: "block", content: "inline*", attrs: { level: { default: 2 }, sectionId: { default: null }, specKey: { default: null } } },
    },
  });
  const h = (level: number, text: string, sectionId: string, specKey: string | null = null) => s.node("heading", { level, sectionId, specKey }, [s.text(text)]);
  const p = (text: string) => s.node("paragraph", null, text ? [s.text(text)] : []);
  const d = s.node("doc", null, [
    h(2, "Aims", "s_aims", "aims"),
    p("Aim one."),
    h(2, "Strategy", "s_strat", "strategy"),
    p("Overview."),
    h(3, "Notes", "s_sub"),
    p("Free sub-heading text."),
    h(3, "Significance", "s_sig", "significance"),
    p("Why it matters."),
    h(2, "Budget", "s_budget"),
    p(""),
  ]);

  it("covers the body up to the next heading at the same level", () => {
    const r = sectionBodyRange(d, "s_aims")!;
    expect(r).toMatchObject({ level: 2, specKey: "aims", heading: "Aims", bodyText: "Aim one." });
    expect(d.nodeAt(r.to)?.textContent).toBe("Strategy");
  });

  it("includes untyped sub-headings but stops at a typed sub-section", () => {
    const r = sectionBodyRange(d, "s_strat")!;
    expect(r.bodyText).toBe("Overview.\n\nNotes\n\nFree sub-heading text.");
    expect(d.nodeAt(r.to)?.textContent).toBe("Significance");
  });

  it("ends a nested section at the next heading of its level or higher", () => {
    const r = sectionBodyRange(d, "s_sig")!;
    expect(r).toMatchObject({ level: 3, bodyText: "Why it matters." });
    expect(d.nodeAt(r.to)?.textContent).toBe("Budget");
  });

  it("runs the last section to the end of the document", () => {
    const r = sectionBodyRange(d, "s_budget")!;
    expect(r.to).toBe(d.content.size);
    expect(r.bodyText).toBe("");
    expect(r.specKey).toBeNull();
  });

  it("returns null for an unknown section id", () => {
    expect(sectionBodyRange(d, "s_missing")).toBeNull();
  });

  describe("sectionHeadingIndexAt", () => {
    // Indexes: 0 Aims, 1 p, 2 Strategy, 3 p, 4 Notes (untyped ###), 5 p, 6 Significance (typed ###), 7 p, 8 Budget, 9 p.
    const idAt = (i: number) => {
      const at = sectionHeadingIndexAt(d, i);
      return at < 0 ? null : d.child(at).attrs.sectionId;
    };

    it("puts a block under an untyped sub-heading in the outer section, where sectionBodyRange puts it", () => {
      expect(idAt(5)).toBe("s_strat");
      expect(idAt(4)).toBe("s_strat");
      expect(sectionBodyRange(d, "s_strat")!.bodyText).toContain("Free sub-heading text.");
    });

    it("stops at a typed sub-section, and at a heading of the same or a higher level", () => {
      expect(idAt(7)).toBe("s_sig");
      expect(idAt(6)).toBe("s_sig");
      expect(idAt(3)).toBe("s_strat");
      expect(idAt(1)).toBe("s_aims");
      expect(idAt(9)).toBe("s_budget");
    });

    it("finds no section before the first heading", () => {
      const doc = s.node("doc", null, [p("Preamble."), h(2, "A", "s_a")]);
      expect(sectionHeadingIndexAt(doc, 0)).toBe(-1);
      expect(sectionHeadingIndexAt(doc, 1)).toBe(1);
    });

    it("keeps a deeper heading after a shallower untyped one in the shallower section", () => {
      const doc = s.node("doc", null, [h(2, "Market", "s_m"), p("Intro."), h(3, "Competitors", "s_c"), p("Rivals."), h(4, "Pricing", "s_p"), p("Cheap.")]);
      expect(sectionHeadingIndexAt(doc, 5)).toBe(0);
      expect(sectionHeadingIndexAt(doc, 3)).toBe(0);
    });
  });
});
