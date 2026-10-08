// Sections of a document. A document is one ProseMirror tree; a section is a
// heading plus everything after it up to the next heading at the same or a
// higher level. Headings carry a stable `sectionId` so section metadata (notes,
// status, the outline item it satisfies) survives edits that move text around.
//
// Pure functions over the stored JSON, shared by the server and the editor.

export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export type SectionInfo = {
  sectionId: string;
  heading: string;
  level: number;
  specKey: string | null;
  /** Index of the heading among the document's top-level nodes. */
  index: number;
  /** Plain text of the section body (without the heading). With `{ own: true }`, only the section's own body. */
  bodyText: string;
  /** With `{ own: true }`: the own body's text without sub-heading titles. */
  proseText?: string;
  /** With `{ own: true }`: the own body has text, a table, an image or a rule (sub-heading titles don't count). */
  hasContent?: boolean;
  /** With `{ own: true }`: the own body holds a table, an image or a rule, which its plain text leaves out or flattens. */
  media?: boolean;
};

export type ListSectionsOptions = {
  /**
   * Each section's own body, as the editor reads it (sectionBodyRange): it
   * stops early at a sub-heading that carries a `specKey`, which is a section
   * of its own in the document's type (NIH's Significance under Research
   * Strategy). Sub-headings without one (a drafted "### Detail") stay part of
   * the body.
   */
  own?: boolean;
};

export const EMPTY_DOC: PMNode = { type: "doc", content: [{ type: "paragraph" }] };

export function nodeText(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const inner = (node.content ?? []).map(nodeText);
  const blocky = ["paragraph", "heading", "listItem", "blockquote", "codeBlock", "tableRow"].includes(node.type);
  return inner.join(node.type === "tableRow" ? "\t" : "") + (blocky ? "\n" : "");
}

/** Plain text of a whole document, blocks separated by newlines. */
export function docText(doc: PMNode | null | undefined): string {
  if (!doc) return "";
  return nodeText(doc).replace(/\n{3,}/g, "\n\n").trim();
}

export function wordCount(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

const MEDIA = new Set(["table", "image", "horizontalRule"]);

function hasMedia(node: PMNode): boolean {
  return MEDIA.has(node.type) || (node.content ?? []).some(hasMedia);
}

/** The document's sections in order. */
export function listSections(doc: PMNode | null | undefined, opts: ListSectionsOptions = {}): SectionInfo[] {
  const nodes = doc?.content ?? [];
  const out: SectionInfo[] = [];
  nodes.forEach((node, index) => {
    if (node.type !== "heading") return;
    const level = Number(node.attrs?.level ?? 1);
    let body = "";
    let prose = "";
    let media = false;
    for (let i = index + 1; i < nodes.length; i++) {
      const next = nodes[i];
      if (next.type === "heading" && (Number(next.attrs?.level ?? 1) <= level || (opts.own && next.attrs?.specKey))) break;
      body += nodeText(next);
      if (next.type !== "heading") {
        prose += nodeText(next);
        media ||= hasMedia(next);
      }
    }
    out.push({
      sectionId: String(node.attrs?.sectionId ?? ""),
      heading: nodeText(node).trim(),
      level,
      specKey: (node.attrs?.specKey as string | null | undefined) ?? null,
      index,
      bodyText: body.trim(),
      ...(opts.own ? { proseText: prose.trim(), hasContent: !!prose.trim() || media, media } : {}),
    });
  });
  return out;
}

/** True when the document has no text at all. */
export function isEmptyDoc(doc: PMNode | null | undefined): boolean {
  return docText(doc) === "";
}

/** A document built from an outline: one heading (with its spec key) and an empty paragraph per section. */
export function docFromOutline(
  sections: Array<{ key: string; heading: string; level?: number }>,
  newId: () => string,
): PMNode {
  const content: PMNode[] = [];
  for (const s of sections) {
    content.push({
      type: "heading",
      attrs: { level: s.level ?? 2, sectionId: newId(), specKey: s.key },
      content: [{ type: "text", text: s.heading }],
    });
    content.push({ type: "paragraph" });
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
