import { describe, expect, it } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { fixSectionIds } from "./extensions";

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
