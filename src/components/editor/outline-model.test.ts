import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import type { SectionSummary } from "@/catalog/schema";
import type { OutlineStatusResponse } from "@/lib/sections/contract";
import { buildOutline, missingSectionInsertPos, readHeadings, rowDisplayStatus, type LiveHeading } from "./outline-model";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 2 }, sectionId: { default: null }, specKey: { default: null } } },
  },
});
const h = (level: number, text: string, sectionId: string, specKey: string | null = null) => schema.node("heading", { level, sectionId, specKey }, [schema.text(text)]);
const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);

const spec = (key: string, order: number, extra: Partial<SectionSummary> = {}): SectionSummary => ({
  key,
  heading: key[0].toUpperCase() + key.slice(1),
  level: 2,
  order,
  required: true,
  elements: [],
  renderer: "narrative",
  ...extra,
});

const sections = [
  spec("aims", 10, { elements: ["goal", "hypotheses"] }),
  spec("strategy", 20),
  spec("significance", 30, { level: 3, elements: ["gap"] }),
  spec("approach", 40, { level: 3 }),
  spec("budget", 50, { required: false }),
];

describe("readHeadings", () => {
  it("doesn't count an untouched scaffold as content", () => {
    const doc = schema.node("doc", null, [h(2, "Header", "s_h", "header"), p("To: "), p("From: ")]);
    const headings = readHeadings(doc);
    expect(headings[0].hasContent).toBe(true);
    const scaffolded = [{ ...spec("header", 5), scaffold: "**To:** \n**From:** " }];
    expect(buildOutline({ sections: scaffolded, headings, status: null, typeKey: "t", notes: {} }).rows[0].status).toBe("missing");
    const filled = readHeadings(schema.node("doc", null, [h(2, "Header", "s_h", "header"), p("To: Ann"), p("From: ")]));
    expect(buildOutline({ sections: scaffolded, headings: filled, status: null, typeKey: "t", notes: {} }).rows[0].status).not.toBe("missing");
  });

  it("reads sectionId, specKey and whether each section has content", () => {
    const doc = schema.node("doc", null, [h(2, "Aims", "s_a", "aims"), p("Goal."), h(2, "Strategy", "s_s", "strategy"), h(3, "Significance", "s_g", "significance"), p("Gap."), h(2, "Extra", "s_x"), p()]);
    const out = readHeadings(doc);
    expect(out.map((x) => [x.id, x.specKey, x.hasContent])).toEqual([
      ["s_a", "aims", true],
      // A parent's own body stops at a typed sub-section (as sectionBodyRange does), so its text doesn't count.
      ["s_s", "strategy", false],
      ["s_g", "significance", true],
      ["s_x", null, false],
    ]);
  });
});

const head = (pos: number, level: number, id: string, specKey: string | null, hasContent = true, text = id): LiveHeading => ({ pos, level, id, specKey, hasContent, text });

describe("buildOutline", () => {
  const headings = [head(0, 2, "s_a", "aims"), head(10, 2, "s_s", "strategy", false), head(20, 3, "s_g", "significance"), head(30, 2, "s_x", null), head(40, 3, "s_y", null), head(50, 2, "s_z", "unknown-key")];
  const status: OutlineStatusResponse = {
    typeKey: "nih",
    typeVersion: 1,
    contentHash: "h",
    computedAt: "",
    model: true,
    sections: [
      { specKey: "aims", heading: "Aims", required: true, sectionId: "s_a", present: true, hasContent: true, elements: [{ element: "goal", status: "done" }] },
      { specKey: "significance", heading: "Significance", required: true, sectionId: "s_g", present: true, hasContent: false, elements: [{ element: "gap", status: "missing" }] },
    ],
    extraSections: [],
  };

  it("merges type sections, live headings and server statuses", () => {
    const { rows, other } = buildOutline({ sections, headings, status, typeKey: "nih", notes: { s_a: "remember X", s_s: "  " } });
    expect(rows.map((r) => [r.key, r.present, r.status, r.hasNotes])).toEqual([
      ["aims", true, "partial", true],
      ["strategy", true, "missing", false],
      ["significance", true, "partial", false],
      ["approach", false, "missing", false],
      ["budget", false, "missing", false],
    ]);
    // Elements the server left out are missing; one it hasn't seen with content is unknown.
    expect(rows[0].elements).toEqual([
      { element: "goal", status: "done" },
      { element: "hypotheses", status: "missing" },
    ]);
    expect(rows[2].elements).toEqual([{ element: "gap", status: "unknown" }]);
    expect(rows[3].elements).toEqual([]);
    expect(rows[4].required).toBe(false);
    // Other sections: untyped or unknown-key headings at the type's top level only.
    expect(other.map((o) => o.id)).toEqual(["s_x", "s_z"]);
  });

  it("marks a present section with content and no elements as done", () => {
    const { rows } = buildOutline({ sections: [spec("intro", 10)], headings: [head(0, 2, "s_i", "intro")], status: null, typeKey: "t", notes: {} });
    expect(rows[0].status).toBe("done");
  });

  it("ignores statuses computed for another type", () => {
    const { rows } = buildOutline({ sections, headings, status, typeKey: "other", notes: {} });
    expect(rows[0].elements.map((e) => e.status)).toEqual(["unknown", "unknown"]);
  });

  it("marks done only when every element is done", () => {
    const done = { ...status, sections: [{ ...status.sections[0], elements: [{ element: "goal", status: "done" as const }, { element: "hypotheses", status: "done" as const }] }] };
    expect(buildOutline({ sections, headings, status: done, typeKey: "nih", notes: {} }).rows[0].status).toBe("done");
  });
});

describe("missingSectionInsertPos", () => {
  const end = 100;
  it("inserts after the nearest earlier present section's range at the new section's level", () => {
    // aims, strategy (with significance) present; approach missing → before the next heading at level ≤ 3 after significance.
    const hs = [head(0, 2, "a", "aims"), head(10, 2, "s", "strategy"), head(20, 3, "g", "significance"), head(30, 2, "x", null)];
    expect(missingSectionInsertPos(sections, "approach", hs, end)).toBe(30);
    // budget (level 2) goes after everything up to the next level-2 heading after significance.
    expect(missingSectionInsertPos(sections, "budget", hs, end)).toBe(30);
  });

  it("puts a missing sub-section inside its parent, before the parent's first sub-section", () => {
    const hs = [head(10, 2, "s", "strategy"), head(20, 3, "p", "approach"), head(40, 2, "b", "budget")];
    expect(missingSectionInsertPos(sections, "significance", hs, end)).toBe(20);
  });

  it("goes before the nearest later section when no earlier one exists, else at the end", () => {
    expect(missingSectionInsertPos(sections, "aims", [head(10, 2, "s", "strategy")], end)).toBe(10);
    expect(missingSectionInsertPos(sections, "aims", [], end)).toBe(end);
    expect(missingSectionInsertPos(sections, "budget", [head(0, 2, "a", "aims")], end)).toBe(end);
  });
});

describe("rowDisplayStatus", () => {
  const el = (status: "done" | "partial" | "missing" | "unknown") => ({ element: status, status });
  it("shows a written section the server hasn't checked as unknown", () => {
    expect(rowDisplayStatus({ status: "partial", elements: [el("unknown"), el("unknown")] })).toBe("unknown");
  });
  it("keeps partial once any element has a verdict", () => {
    expect(rowDisplayStatus({ status: "partial", elements: [el("unknown"), el("done")] })).toBe("partial");
  });
  it("passes done and missing through", () => {
    expect(rowDisplayStatus({ status: "done", elements: [] })).toBe("done");
    expect(rowDisplayStatus({ status: "missing", elements: [el("missing")] })).toBe("missing");
  });
});
