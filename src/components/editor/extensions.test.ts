import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { isAllowedUri } from "@tiptap/extension-link";
import { DOMParser as PMDOMParser, DOMSerializer, Node as PMNodeClass, Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { parseHTML } from "linkedom";
import type { PMNode as PMJSON } from "@/lib/documents/sections";
import { tableSnapshotNodes } from "@/lib/data/snapshot";
import { documentExtensions, fixSectionIds, gutterButton, gutterDecorations } from "./extensions";

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

describe("DataTable", () => {
  // The document schema (no editor view needed), serialized and parsed through a linkedom document as getHTML and setContent do.
  const docSchema = getSchema(documentExtensions());
  const { document } = parseHTML("<!doctype html><html><body></body></html>") as unknown as { document: Document };

  const toHTML = (json: PMJSON) => {
    const node = PMNodeClass.fromJSON(docSchema, json);
    const wrap = document.createElement("div");
    wrap.appendChild(DOMSerializer.fromSchema(docSchema).serializeFragment(node.content, { document }));
    return wrap.innerHTML;
  };
  const fromHTML = (html: string) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    return PMDOMParser.fromSchema(docSchema).parse(wrap as unknown as globalThis.Node).toJSON() as PMJSON;
  };

  const snap = tableSnapshotNodes(
    {
      table: {
        id: "11111111-1111-4111-8111-111111111111",
        source_id: "22222222-2222-4222-8222-222222222222",
        source: { id: "22222222-2222-4222-8222-222222222222", title: "Budget", filename: null, kind: "file", mime: null },
        name: "Costs",
        columns: [
          { key: "c1", label: "Item", type: "text", inferred: "text", unit: null },
          { key: "c2", label: "Amount", type: "number", inferred: "number", unit: null },
        ],
        row_count: 1,
        status: "active",
        superseded_by: null,
        extraction_method: "csv",
        sheet: null,
        page: null,
        page_end: null,
        confidence: null,
        notes: "",
        truncated: false,
        override_count: 0,
        document_ids: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      rows: [{ idx: 0, cells: ["Rent", "1200"] }],
    },
    { rows: 1, at: "2026-10-08T09:00:00.000Z" },
  );

  it("writes the data-table attributes and reads them back", () => {
    const html = toHTML({ type: "doc", content: snap });
    expect(html).toContain('data-table-id="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('data-source-id="22222222-2222-4222-8222-222222222222"');
    expect(html).toContain('data-snapshot-at="2026-10-08T09:00:00.000Z"');
    const back = fromHTML(html);
    const table = back.content!.find((n) => n.type === "table")!;
    expect(table.attrs).toMatchObject({ dataTableId: "11111111-1111-4111-8111-111111111111", sourceId: "22222222-2222-4222-8222-222222222222", snapshotAt: "2026-10-08T09:00:00.000Z" });
  });

  it("keeps the citation's relative library link", () => {
    const html = toHTML({ type: "doc", content: snap });
    // linkedom leaves "&" unescaped in attributes; a browser writes "&amp;".
    expect(html).toMatch(/href="\/library\?source=22222222-2222-4222-8222-222222222222&(amp;)?table=11111111-1111-4111-8111-111111111111"/);
    const back = fromHTML(html);
    const cite = back.content!.find((n) => n.type === "paragraph" && n.content?.some((c) => c.marks?.length))!;
    const mark = cite.content!.find((c) => c.marks?.length)!.marks![0];
    expect(mark.type).toBe("link");
    expect(mark.attrs?.href).toBe("/library?source=22222222-2222-4222-8222-222222222222&table=11111111-1111-4111-8111-111111111111");
    expect(isAllowedUri("/library?source=a&table=b")).toBeTruthy();
  });

  it("leaves a plain table without the attributes", () => {
    const plain: PMJSON = {
      type: "doc",
      content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] }] }],
    };
    const html = toHTML(plain);
    expect(html).not.toContain("data-table-id");
    expect(html).not.toContain("data-source-id");
    expect(fromHTML(html).content![0].attrs).toMatchObject({ dataTableId: null, sourceId: null, snapshotAt: null });
  });
});
