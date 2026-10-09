import { describe, expect, it } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { SectionSummary } from "@/catalog/schema";
import { draftRow, rewriteInsertion, rewriteTarget, rewriteTargetLine, wordCount } from "./tools-panel-model";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 2 }, sectionId: { default: null }, specKey: { default: null } } },
    list_item: { content: "paragraph+" },
    bullet_list: { group: "block", content: "list_item+" },
  },
});
const h = (text: string, sectionId: string, specKey: string | null = null) => schema.node("heading", { level: 2, sectionId, specKey }, text ? [schema.text(text)] : []);
const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const ul = (...items: string[]) => schema.node("bullet_list", null, items.map((t) => schema.node("list_item", null, [p(t)])));

/** A state with the caret (or a selection) at the given positions. */
function at(doc: PMNode, from: number, to = from) {
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

// <h2>Aims</h2> = 0..6, <p>Write the aims.</p> = 6..23, <h2>Empty</h2> = 23..30, <p></p> = 30..32.
const doc = schema.node("doc", null, [h("Aims", "s1"), p("Write the aims."), h("Empty", "s2"), p()]);

describe("rewriteTarget", () => {
  it("is the selection when it holds text", () => {
    const t = rewriteTarget(at(doc, 7, 12), "s1");
    expect(t).toEqual({ kind: "selection", from: 7, to: 12, text: "Write" });
    expect(rewriteTargetLine(t)).toBe("Rewrites your selection.");
  });

  it("ignores a selection of nothing but whitespace", () => {
    const spaced = schema.node("doc", null, [p("a   b")]);
    expect(rewriteTarget(at(spaced, 2, 5), null)).toEqual({ kind: "block", from: 1, to: 6, text: "a   b" });
  });

  it("is the caret's section when its body has text", () => {
    const t = rewriteTarget(at(doc, 10), "s1");
    expect(t).toEqual({ kind: "section", sectionId: "s1", heading: "Aims" });
    expect(rewriteTargetLine(t)).toBe("Rewrites “Aims”.");
  });

  it("names an untitled section", () => {
    expect(rewriteTargetLine({ kind: "section", sectionId: "x", heading: "  " })).toBe("Rewrites “Untitled section”.");
  });

  it("is nothing in an empty section, and never the heading itself", () => {
    expect(rewriteTarget(at(doc, 31), "s2")).toEqual({ kind: "none" });
    expect(rewriteTarget(at(doc, 26), "s2")).toEqual({ kind: "none" });
    expect(rewriteTargetLine({ kind: "none" })).toBe("Select text or put the cursor in a section.");
  });

  it("falls back to the caret's paragraph in a document without headings", () => {
    const plain = schema.node("doc", null, [p("First one."), p("Second.")]);
    // The second paragraph starts at 12; its inside is 13..20.
    const t = rewriteTarget(at(plain, 15), null);
    expect(t).toEqual({ kind: "block", from: 13, to: 20, text: "Second." });
    expect(rewriteTargetLine(t)).toBe("Rewrites this paragraph.");
  });

  it("takes a list block whole", () => {
    const listed = schema.node("doc", null, [ul("one", "two")]);
    const t = rewriteTarget(at(listed, 3), null);
    expect(t).toMatchObject({ kind: "block", from: 0, to: listed.content.size });
  });

  it("is nothing in an empty document", () => {
    expect(rewriteTarget(at(schema.node("doc", null, [p()]), 1), null)).toEqual({ kind: "none" });
  });
});

const spec = (key: string, renderer: SectionSummary["renderer"]): SectionSummary => ({ key, heading: key, level: 2, order: 1, required: false, elements: [], renderer });

describe("draftRow", () => {
  it("drafts an empty section and drafts again over a written one", () => {
    expect(draftRow(doc, null, "s2", new Set())).toEqual({ label: "Draft this section", sectionId: "s2", disabledReason: null });
    expect(draftRow(doc, null, "s1", new Set())).toEqual({ label: "Draft again", sectionId: "s1", disabledReason: null });
  });

  it("needs a caret section", () => {
    expect(draftRow(doc, null, null, new Set()).disabledReason).toBe("Put the cursor in a section");
    expect(draftRow(doc, null, "gone", new Set()).disabledReason).toBe("Put the cursor in a section");
  });

  it("waits while Claude writes the section", () => {
    expect(draftRow(doc, null, "s1", new Set(["s1"])).disabledReason).toBe("Claude is writing…");
  });

  it("won't draft a static section or one without a heading", () => {
    const typed = schema.node("doc", null, [h("Signature", "s1", "sig"), p(), h("", "s2", "aims"), p()]);
    expect(draftRow(typed, [spec("sig", "static"), spec("aims", "narrative")], "s1", new Set()).disabledReason).toBe("Fixed text");
    expect(draftRow(typed, [spec("sig", "static"), spec("aims", "narrative")], "s2", new Set()).disabledReason).toBe("Add a heading first");
  });
});

describe("wordCount", () => {
  it("counts words across blocks", () => {
    expect(wordCount(doc)).toBe(5);
    expect(wordCount(schema.node("doc", null, [p()]))).toBe(0);
  });
});

describe("rewriteInsertion", () => {
  const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

  it("puts one paragraph's text into a range inside one block, so the block keeps its type", () => {
    expect(rewriteInsertion(doc, { from: 7, to: 12 }, [para("Draft")])).toEqual({ from: 7, to: 12, content: [{ type: "text", text: "Draft" }] });
    // Several paragraphs back go in as blocks (ProseMirror splits the block around them).
    const two = [para("One."), para("Two.")];
    expect(rewriteInsertion(doc, { from: 7, to: 22 }, two)).toEqual({ from: 7, to: 22, content: two });
  });

  it("replaces whole blocks when the range runs from the start of a heading to the end of its paragraph", () => {
    // "Aims" + "Write the aims.": 1..22, inside <h2> (0..6) and <p> (6..23).
    const r = rewriteInsertion(doc, { from: 1, to: 22 }, [para("Shorter aims.")]);
    expect(r).toEqual({ from: 0, to: 23, content: [para("Shorter aims.")] });
    const replaced = EditorState.create({ doc }).tr.replaceWith(r.from, r.to, schema.nodeFromJSON(r.content[0] as object)).doc;
    expect(replaced.child(0).type.name).toBe("paragraph");
    expect(replaced.child(0).textContent).toBe("Shorter aims.");
    expect(replaced.child(1).textContent).toBe("Empty");
  });

  it("keeps the heading when the result gives its words back as the first line", () => {
    const back = [para("Aims"), para("Shorter aims.")];
    const r = rewriteInsertion(doc, { from: 1, to: 22 }, back);
    expect(r).toEqual({ from: 0, to: 23, content: [{ ...back[0], type: "heading", attrs: { level: 2, sectionId: "s1", specKey: null } }, back[1]] });
    const replaced = EditorState.create({ doc }).tr.replaceWith(r.from, r.to, r.content.map((b) => schema.nodeFromJSON(b))).doc;
    expect(replaced.child(0).type.name).toBe("heading");
    expect(replaced.child(0).attrs.sectionId).toBe("s1");
    expect(replaced.child(0).textContent).toBe("Aims");
    expect(replaced.child(1).textContent).toBe("Shorter aims.");
  });

  it("leaves a range that starts or ends inside a block as it is", () => {
    expect(rewriteInsertion(doc, { from: 3, to: 22 }, [para("x")])).toEqual({ from: 3, to: 22, content: [{ type: "text", text: "x" }] });
    expect(rewriteInsertion(doc, { from: 1, to: 12 }, [para("x")])).toEqual({ from: 1, to: 12, content: [{ type: "text", text: "x" }] });
  });
});
