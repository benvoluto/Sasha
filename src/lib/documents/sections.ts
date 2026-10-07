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
  /** Plain text of the section body (without the heading). */
  bodyText: string;
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

/** The document's sections in order. */
export function listSections(doc: PMNode | null | undefined): SectionInfo[] {
  const nodes = doc?.content ?? [];
  const out: SectionInfo[] = [];
  nodes.forEach((node, index) => {
    if (node.type !== "heading") return;
    const level = Number(node.attrs?.level ?? 1);
    let body = "";
    for (let i = index + 1; i < nodes.length; i++) {
      const next = nodes[i];
      if (next.type === "heading" && Number(next.attrs?.level ?? 1) <= level) break;
      body += nodeText(next);
    }
    out.push({
      sectionId: String(node.attrs?.sectionId ?? ""),
      heading: nodeText(node).trim(),
      level,
      specKey: (node.attrs?.specKey as string | null | undefined) ?? null,
      index,
      bodyText: body.trim(),
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
