import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import { history, undo } from "@tiptap/pm/history";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { applyOutlineMerge } from "@/components/editor/apply-outline";
import type { DocumentTypeSummary } from "./schema";
import type { PMNode } from "@/lib/documents/sections";
import { docOf, heading, para } from "@/lib/sections/test-fixtures";
import { normalizeHeading, planOutlineMerge } from "./outline-merge";

// Outline order: intro (10), budget (20), timeline (30), risks (40).
const sections = [
  { key: "timeline", heading: "Timeline", order: 30, level: 2 as const },
  { key: "intro", heading: "Introduction", order: 10, level: 2 as const },
  { key: "budget", heading: "Budget & Costs", order: 20, level: 2 as const },
  { key: "risks", heading: "Risks", order: 40, level: 2 as const },
];

const keysOf = (plan: ReturnType<typeof planOutlineMerge>) => plan.insert.map((i) => [i.afterIndex, i.sections.map((s) => s.key)]);

/** Apply a plan to the JSON the way apply-outline.ts does to the editor (tags in place, inserts from the end). */
function apply(doc: PMNode, plan: ReturnType<typeof planOutlineMerge>): PMNode {
  const content: PMNode[] = (doc.content ?? []).map((n) => ({ ...n, attrs: n.attrs ? { ...n.attrs } : undefined }));
  for (const t of plan.tag) content[t.index].attrs = { ...content[t.index].attrs, specKey: t.specKey };
  for (const ins of [...plan.insert].reverse()) {
    content.splice(ins.afterIndex + 1, 0, ...ins.sections.flatMap((s) => [heading(s.heading, `new_${s.key}`, s.key, s.level ?? 2), para("")]));
  }
  return { ...doc, content };
}

describe("normalizeHeading", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(normalizeHeading("  Budget &   COSTS: ")).toBe("budget costs");
  });
});

describe("planOutlineMerge", () => {
  it("tags untagged headings by text, including numbered ones", () => {
    const doc = docOf(heading("1. Introduction", "a"), para("Hello."), heading("II. budget & costs", "b"), para("Money."), heading("Timeline", "c", null, 3), heading("Risks", "d", null, 4));
    const plan = planOutlineMerge(doc, sections);
    expect(plan.tag).toEqual([
      { index: 0, specKey: "intro" },
      { index: 2, specKey: "budget" },
      { index: 4, specKey: "timeline" },
    ]);
    // Level 4 is too deep to tag: risks goes after the last present section's body (timeline, a level-3 heading).
    expect(keysOf(plan)).toEqual([[5, ["risks"]]]);
    expect(plan.inOrder).toBe(true);
  });

  it("keeps headings already tagged and does not re-tag a second heading with the same text", () => {
    const doc = docOf(heading("Intro", "a", "intro"), heading("Introduction", "b"), para("x"));
    const plan = planOutlineMerge(doc, sections);
    expect(plan.tag).toEqual([]);
    // The intro section ends at the next heading of its level, the untagged one.
    expect(keysOf(plan)).toEqual([[0, ["budget", "timeline", "risks"]]]);
  });

  it("inserts missing sections between present ones in outline order", () => {
    const doc = docOf(
      para("Preamble."),
      heading("Introduction", "a"),
      para("Intro text."),
      heading("Detail", "x", null, 3),
      para("Sub text."),
      heading("Risks", "b"),
      para("Floods."),
      heading("Appendix", "c"),
    );
    const plan = planOutlineMerge(doc, sections);
    expect(plan.tag.map((t) => t.specKey)).toEqual(["intro", "risks"]);
    // Budget and timeline follow the introduction's whole body (its sub-heading included), before Risks.
    expect(keysOf(plan)).toEqual([[4, ["budget", "timeline"]]]);
    const merged = apply(doc, plan);
    expect(merged.content!.map((n) => (n.type === "heading" ? `#${n.attrs!.specKey ?? n.content![0].text}` : n.content?.[0]?.text ?? ""))).toEqual([
      "Preamble.",
      "#intro",
      "Intro text.",
      "#Detail",
      "Sub text.",
      "#budget",
      "",
      "#timeline",
      "",
      "#risks",
      "Floods.",
      "#Appendix",
    ]);
  });

  it("puts sections with nothing before them ahead of the first present one", () => {
    const doc = docOf(para("Preamble."), heading("Timeline", "a"), para("Q1."));
    const plan = planOutlineMerge(doc, sections);
    expect(keysOf(plan)).toEqual([
      [0, ["intro", "budget"]],
      [2, ["risks"]],
    ]);
    expect(plan.inOrder).toBe(true);
  });

  it("appends everything at the end when no section is present", () => {
    const doc = docOf(para("Just prose."), heading("Notes", "a"), para("More."));
    const plan = planOutlineMerge(doc, sections);
    expect(plan.tag).toEqual([]);
    expect(keysOf(plan)).toEqual([[2, ["intro", "budget", "timeline", "risks"]]]);
    expect(plan.inOrder).toBe(false);
  });

  it("never touches existing nodes: prose and order are preserved", () => {
    const doc = docOf(para("First."), heading("Budget & costs", "a"), para("Second."), heading("Other", "b"), para("Third."));
    const merged = apply(doc, planOutlineMerge(doc, sections));
    const original = doc.content!.map((n) => JSON.stringify({ type: n.type, content: n.content }));
    const kept = merged.content!.filter((n) => !String(n.attrs?.sectionId ?? "").startsWith("new_") && !(n.type === "paragraph" && !n.content)).map((n) => JSON.stringify({ type: n.type, content: n.content }));
    expect(kept).toEqual(original);
  });

  it("is idempotent: a second apply adds and tags nothing", () => {
    const doc = docOf(para("Text."), heading("2) Timeline", "a"), para("Q1."));
    const once = apply(doc, planOutlineMerge(doc, sections));
    const twice = planOutlineMerge(once, sections);
    expect(twice).toEqual({ tag: [], insert: [], inOrder: false });
  });

  it("handles an empty document", () => {
    expect(keysOf(planOutlineMerge(docOf(), sections))).toEqual([[-1, ["intro", "budget", "timeline", "risks"]]]);
  });
});

describe("applyOutlineMerge (editor transaction)", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      text: { group: "inline" },
      paragraph: { group: "block", content: "inline*" },
      heading: { group: "block", content: "inline*", attrs: { level: { default: 2 }, sectionId: { default: null }, specKey: { default: null } } },
    },
  });

  /** Enough of a TipTap editor for applyOutlineMerge: state, schema and a dispatching view. */
  function fakeEditor(doc: PMNode) {
    const holder = { state: EditorState.create({ schema, doc: schema.nodeFromJSON(doc), plugins: [history()] }) };
    const editor = {
      get state() {
        return holder.state;
      },
      view: { dispatch: (tr: Transaction) => (holder.state = holder.state.apply(tr)) },
    };
    return { editor: editor as unknown as Editor, holder };
  }

  const type = { key: "t", title: "T", sections: sections.map((s) => ({ ...s, required: true, elements: [], renderer: "narrative", lengthHint: null, scaffold: null })) } as unknown as DocumentTypeSummary;
  const headings = (d: PMNode) => (d.content ?? []).map((n) => (n.type === "heading" ? `#${n.attrs?.specKey ?? ""}:${n.content?.[0]?.text ?? ""}` : (n.content?.[0]?.text ?? "")));

  it("tags and inserts in one undoable step", () => {
    const doc = docOf(para("Preamble."), heading("1. Introduction", "a"), para("Intro."), heading("Risks", "b"), para("Floods."));
    const { editor, holder } = fakeEditor(doc);
    let n = 0;
    const result = applyOutlineMerge(editor, type, () => `s_new${++n}`);
    expect(result).toEqual({ added: 2, tagged: 2, inOrder: true });
    expect(headings(holder.state.doc.toJSON() as PMNode)).toEqual([
      "Preamble.",
      "#intro:1. Introduction",
      "Intro.",
      "#budget:Budget & Costs",
      "",
      "#timeline:Timeline",
      "",
      "#risks:Risks",
      "Floods.",
    ]);
    // A second apply finds everything.
    expect(applyOutlineMerge(editor, type, () => "s_x")).toEqual({ added: 0, tagged: 0, inOrder: false });
    // One undo restores the original document exactly.
    undo(holder.state, (tr) => (holder.state = holder.state.apply(tr)));
    expect(holder.state.doc.toJSON()).toEqual(schema.nodeFromJSON(doc).toJSON());
  });
});
