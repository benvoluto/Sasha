import { describe, expect, it } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { parseHTML } from "linkedom";
import { fixSectionIds, gutterButton, gutterDecorations } from "./extensions";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 2 }, sectionId: { default: null }, specKey: { default: null } } },
  },
});

const h = (text: string, sectionId: string | null, specKey: string | null = null) => schema.node("heading", { level: 2, sectionId, specKey }, [schema.text(text)]);
const p = (text: string) => schema.node("paragraph", null, [schema.text(text)]);

/** Apply a transaction and the plugin's fix; returns each heading's [text, sectionId, specKey]. */
function run(doc: PMNode, edit: (s: EditorState) => ReturnType<EditorState["tr"]["insert"]>) {
  const state = EditorState.create({ schema, doc });
  const tr = edit(state);
  let next = state.apply(tr);
  const fix = fixSectionIds([tr], next);
  if (fix) next = next.apply(fix);
  const out: Array<[string, string | null, string | null]> = [];
  next.doc.forEach((n) => {
    if (n.type.name === "heading") out.push([n.textContent, n.attrs.sectionId, n.attrs.specKey]);
  });
  return out;
}

describe("fixSectionIds", () => {
  it("keeps the id on the existing heading when a copy is pasted above it", () => {
    const doc = schema.node("doc", null, [p("intro"), h("Findings", "s_a", "findings")]);
    // Paste a copy of the heading before the intro paragraph.
    const out = run(doc, (s) => s.tr.insert(0, h("Findings copy", "s_a", "findings")));
    expect(out[1]).toEqual(["Findings", "s_a", "findings"]);
    expect(out[0][1]).not.toBe("s_a");
    expect(out[0][2]).toBeNull();
  });

  it("renames a copy pasted below the original", () => {
    const doc = schema.node("doc", null, [h("Findings", "s_a"), p("body")]);
    const out = run(doc, (s) => s.tr.insert(s.doc.content.size, h("Findings", "s_a")));
    expect(out[0][1]).toBe("s_a");
    expect(out[1][1]).not.toBe("s_a");
  });

  it("gives an id to a heading without one", () => {
    const doc = schema.node("doc", null, [p("body")]);
    const out = run(doc, (s) => s.tr.insert(0, h("New", null, "methods")));
    expect(out[0][1]).toMatch(/^s_/);
    expect(out[0][2]).toBe("methods");
  });

  it("does nothing when the ids are already unique", () => {
    const doc = schema.node("doc", null, [h("A", "s_a"), h("B", "s_b")]);
    const state = EditorState.create({ schema, doc });
    const tr = state.tr.insertText("!", 2);
    expect(fixSectionIds([tr], state.apply(tr))).toBeNull();
  });
});

describe("heading gutter", () => {
  const doc = schema.node("doc", null, [h("Aims", "s_a", "aims"), p("body"), h("Approach", "s_b"), p("more")]);

  it("puts a margin button and an inline button on every heading", () => {
    const state = EditorState.create({ schema, doc });
    const decos = gutterDecorations(state, new Set(), {}).find();
    const widgets = decos.filter((d) => d.spec.sectionId);
    expect(widgets.map((d) => d.spec.sectionId)).toEqual(["s_a", "s_a", "s_b", "s_b"]);
    // The margin button sits at the start of the heading text.
    expect(widgets[0].from).toBe(1);
    expect(widgets[0].spec.key).toMatch(/^gutter-s_a-idle/);
    expect(widgets[1].spec.key).toMatch(/^gutter-inline-s_a-idle/);
  });

  it("marks busy sections and the heading holding the caret", () => {
    let state = EditorState.create({ schema, doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    const decos = gutterDecorations(state, new Set(["s_b"]), {}).find();
    const nodeAttrs = decos.filter((d) => !d.spec.sectionId).map((d) => [d.from, (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs]);
    const second = doc.child(0).nodeSize + doc.child(1).nodeSize;
    expect(nodeAttrs).toEqual([
      [0, { class: "has-caret", "aria-label": "Aims" }],
      [second, { class: "section-busy", "aria-label": "Approach", "aria-busy": "true" }],
    ]);
    expect(decos.find((d) => d.spec.sectionId === "s_b")?.spec.key).toMatch(/-busy-/);
  });

  it("names each heading by its own text, not the gutter button inside it", () => {
    const state = EditorState.create({ schema, doc });
    const labels = gutterDecorations(state, new Set(), {})
      .find()
      .filter((d) => !d.spec.sectionId)
      .map((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs["aria-label"]);
    expect(labels).toEqual(["Aims", "Approach"]);
  });

  it("renders a button carrying the section id that calls the handler", () => {
    const { document, Event: DomEvent } = parseHTML("<!doctype html><html><body></body></html>") as unknown as { document: Document; Event: typeof Event };
    const calls: string[] = [];
    const b = gutterButton(document, "s_a", { busy: false, inline: false, heading: "Aims" }, { onSectionMenu: (id) => calls.push(id) });
    expect(b.getAttribute("data-section-id")).toBe("s_a");
    expect(b.getAttribute("aria-label")).toBe("Section actions: Aims");
    b.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    b.dispatchEvent(new DomEvent("click"));
    expect(calls).toEqual(["s_a"]);
  });
});
