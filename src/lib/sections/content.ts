// Turning model Markdown into blocks that can be inserted as a section body.
// Pure and client-safe: the editor calls this on the `markdown` a section
// generate route returns, then inserts the blocks as one transaction.
//
// CONTRACT (Phase 3): shared by the generation-backend track (owner) and the
// editor-ui track.

import { markdownToTiptap, type MarkdownOptions } from "@/lib/report/markdown-to-tiptap";
import type { PMNode } from "@/lib/documents/sections";

/** Citation markers ([[p:S1234abcd.P3]]) are a Phase 7 feature; until then they are removed before conversion. */
export function stripCitationMarkers(markdown: string): string {
  return markdown.replace(/\s?\[\[p:[^\]]*\]\]/g, "");
}

/**
 * Blocks for a section body. A generated heading at or above the section's own
 * level would split the section, so headings are pushed below it (capped at 3;
 * a heading that can't go lower becomes a bold paragraph). Never returns an
 * empty list: an empty result is one empty paragraph. `lineBreaks` keeps each
 * line of a paragraph on its own line (scaffolds and fixed front matter, whose
 * fields are written one per line).
 */
export function sectionBlocksFromMarkdown(markdown: string, sectionLevel: number, opts: MarkdownOptions = {}): PMNode[] {
  const doc = markdownToTiptap(stripCitationMarkers(markdown).trim(), opts);
  const out: PMNode[] = [];
  for (const node of doc.content as PMNode[]) {
    if (node.type !== "heading") {
      out.push(node);
      continue;
    }
    const level = Number(node.attrs?.level ?? 2);
    const target = Math.max(level, sectionLevel + 1);
    if (target <= 3) out.push({ ...node, attrs: { level: target } });
    else out.push({ type: "paragraph", content: (node.content ?? []).map((c) => (c.type === "text" ? { ...c, marks: [...(c.marks ?? []), { type: "bold" }] } : c)) });
  }
  return out.length ? out : [{ type: "paragraph" }];
}
