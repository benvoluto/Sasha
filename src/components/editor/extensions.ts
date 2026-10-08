// The document editor's extension set: the report editor's schema plus stable
// section ids on headings, highlight, the "filled" mark for text that came from
// sources or notes, and the dividers between sections. Client-only.

import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Extensions } from "@tiptap/react";

export const newSectionId = () => `s_${Math.random().toString(36).slice(2, 10)}`;

/** The ranges of `state.doc` that the transactions inserted or replaced. */
function changedRanges(transactions: readonly Transaction[]): Array<[number, number]> {
  const maps = transactions.flatMap((t) => t.mapping.maps);
  const out: Array<[number, number]> = [];
  maps.forEach((map, i) => {
    const rest = new Mapping(maps.slice(i + 1));
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd > newStart) out.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  });
  return out;
}

/**
 * Give every heading an id, and a fresh one to a heading whose id is already
 * taken (a heading split, or pasted from elsewhere in the document). Of two
 * headings with the same id, the one that was already there keeps it and the
 * copy the transactions brought in is renamed, wherever in the document it
 * landed; when that can't be told apart, the first keeps it.
 */
export function fixSectionIds(transactions: readonly Transaction[], state: EditorState): Transaction | null {
  if (!transactions.some((t) => t.docChanged)) return null;
  const heads: Array<{ pos: number; node: PMNode; id: string | null }> = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    heads.push({ pos, node, id: (node.attrs.sectionId as string | null) || null });
    return false;
  });
  const changed = changedRanges(transactions);
  const isNew = (pos: number) => changed.some(([from, to]) => pos >= from && pos < to);
  // Which heading keeps each id.
  const keeper = new Map<string, number>();
  for (const h of heads) {
    if (!h.id) continue;
    const kept = keeper.get(h.id);
    if (kept === undefined || (isNew(kept) && !isNew(h.pos))) keeper.set(h.id, h.pos);
  }
  let tr: Transaction | null = null;
  for (const h of heads) {
    if (h.id && keeper.get(h.id) === h.pos) continue;
    tr ??= state.tr;
    // A copy also drops the outline item it satisfied; the original still does.
    tr.setNodeMarkup(h.pos, undefined, { ...h.node.attrs, sectionId: newSectionId(), specKey: h.id ? null : h.node.attrs.specKey });
  }
  if (tr) (tr as Transaction).setMeta("addToHistory", false);
  return tr;
}

/** Headings with a stable `sectionId` (and the outline item they satisfy, `specKey`). */
const SectionHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      sectionId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-section-id"),
        renderHTML: (attrs) => (attrs.sectionId ? { "data-section-id": attrs.sectionId } : {}),
      },
      specKey: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-spec-key"),
        renderHTML: (attrs) => (attrs.specKey ? { "data-spec-key": attrs.specKey } : {}),
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("sectionIds"),
        appendTransaction: (transactions, _old, state) => fixSectionIds(transactions, state),
      }),
    ];
  },
});

/** Text filled in from sources or notes; shown in the accent color until someone edits around it. */
export const Filled = Mark.create({
  name: "filled",
  inclusive: false,
  parseHTML: () => [{ tag: "span[data-filled]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-filled": "", class: "filled-text" }), 0],
});

// --- Section dividers ---------------------------------------------------------

export type SectionDividerHandlers = {
  /** Called before a section is removed (take a snapshot, show an undo notice). */
  onDeleteSection?: (heading: string) => void;
};

const dividerKey = new PluginKey("sectionDividers");

/** Top-level positions of headings at the top outline level (the smallest level used). */
function topHeadings(doc: PMNode): Array<{ pos: number; node: PMNode }> {
  const out: Array<{ pos: number; node: PMNode }> = [];
  let min = 7;
  doc.forEach((node) => {
    if (node.type.name === "heading") min = Math.min(min, Number(node.attrs.level));
  });
  doc.forEach((node, pos) => {
    if (node.type.name === "heading" && Number(node.attrs.level) === min) out.push({ pos, node });
  });
  return out;
}

/** The range [from, to) a section covers: its heading up to the next heading at the same or a higher level. */
export function sectionRange(doc: PMNode, headingPos: number): { from: number; to: number } {
  const heading = doc.nodeAt(headingPos);
  const level = Number(heading?.attrs.level ?? 1);
  let to = doc.content.size;
  doc.forEach((node, pos) => {
    if (pos > headingPos && to === doc.content.size && node.type.name === "heading" && Number(node.attrs.level) <= level) to = pos;
  });
  return { from: headingPos, to };
}

function insertSection(view: EditorView, at: number) {
  const { schema } = view.state;
  const level = Number(topHeadings(view.state.doc)[0]?.node.attrs.level ?? 2);
  const heading = schema.nodes.heading.create({ level, sectionId: newSectionId() }, schema.text("New section"));
  const tr = view.state.tr.insert(at, [heading, schema.nodes.paragraph.create()]);
  // Select the placeholder heading text so typing replaces it.
  tr.setSelection(TextSelection.create(tr.doc, at + 1, at + 1 + "New section".length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function deleteSection(view: EditorView, headingPos: number, handlers: SectionDividerHandlers) {
  const { doc, schema } = view.state;
  const node = doc.nodeAt(headingPos);
  if (!node) return;
  handlers.onDeleteSection?.(node.textContent);
  const { from, to } = sectionRange(doc, headingPos);
  const tr = view.state.tr;
  if (from === 0 && to === doc.content.size) tr.replaceWith(0, doc.content.size, schema.nodes.paragraph.create());
  else tr.delete(from, to);
  view.dispatch(tr);
  view.focus();
}

function button(label: string, title: string, svgPath: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "section-divider-btn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<svg viewBox="0 0 256 256" width="18" height="18" aria-hidden="true"><path d="${svgPath}" fill="currentColor"/></svg><span class="sr-only">${label}</span>`;
  // mousedown would move the selection into the widget; keep the editor's.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

// Phosphor "PlusCircle" and "Trash" (regular), inlined so the widget needs no React.
const PLUS =
  "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm48-88a8,8,0,0,1-8,8H136v32a8,8,0,0,1-16,0V136H88a8,8,0,0,1,0-16h32V88a8,8,0,0,1,16,0v32h32A8,8,0,0,1,176,128Z";
const TRASH =
  "M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z";

function dividerWidget(view: EditorView, getPos: () => number | undefined, headingPos: number | null, handlers: SectionDividerHandlers): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "section-divider";
  wrap.contentEditable = "false";
  const line = () => {
    const l = document.createElement("span");
    l.className = "section-divider-line";
    return l;
  };
  wrap.append(line());
  const actions = document.createElement("span");
  actions.className = "section-divider-actions";
  actions.append(
    button("Add section", "Add a section here", PLUS, () => {
      const pos = getPos();
      if (pos !== undefined) insertSection(view, pos);
    }),
  );
  if (headingPos !== null) {
    actions.append(
      button("Delete section", "Delete the section below", TRASH, () => {
        const pos = getPos();
        if (pos !== undefined) deleteSection(view, pos, handlers);
      }),
    );
  }
  wrap.append(actions, line());
  return wrap;
}

function dividerDecorations(state: EditorState, handlers: SectionDividerHandlers): DecorationSet {
  const decos: Decoration[] = [];
  const heads = topHeadings(state.doc);
  for (const { pos, node } of heads) {
    if (pos === 0) continue; // no divider above the first block
    decos.push(
      Decoration.widget(pos, (view, getPos) => dividerWidget(view, getPos, pos, handlers), {
        side: -1,
        key: `div-${node.attrs.sectionId ?? pos}`,
        ignoreSelection: true,
      }),
    );
  }
  if (heads.length > 0) {
    const end = state.doc.content.size;
    decos.push(Decoration.widget(end, (view, getPos) => dividerWidget(view, getPos, null, handlers), { side: 1, key: "div-end", ignoreSelection: true }));
  }
  return DecorationSet.create(state.doc, decos);
}

export const SectionDividers = Extension.create<SectionDividerHandlers>({
  name: "sectionDividers",
  addOptions: () => ({}),
  addProseMirrorPlugins() {
    const handlers = this.options;
    return [
      new Plugin({
        key: dividerKey,
        props: {
          decorations: (state) => dividerDecorations(state, handlers),
        },
      }),
    ];
  },
});

export function documentExtensions(handlers: SectionDividerHandlers = {}): Extensions {
  return [
    StarterKit.configure({ heading: false }),
    SectionHeading.configure({ levels: [1, 2, 3] }),
    Underline,
    Highlight,
    Filled,
    Link.configure({ openOnClick: false, autolink: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false, allowBase64: true }),
    Placeholder.configure({
      placeholder: ({ editor, node }) =>
        node.type.name === "heading" ? "Heading" : editor.isEmpty ? "Start writing, or choose a document type above…" : "Write this section…",
      showOnlyCurrent: false,
    }),
    SectionDividers.configure(handlers),
  ];
}
