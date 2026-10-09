// Turning model Markdown into blocks that can be inserted as a section body.
// Pure and client-safe: the editor calls this on the `markdown` a section
// generate route returns, then inserts the blocks as one transaction.
//
// CONTRACT (Phase 3): shared by the generation-backend track (owner) and the
// editor-ui track.

import { LEFTOVER_MARKER_RE, MARKER_RE, type CitationReport } from "@/lib/citations/contract";
import { markCitations } from "@/lib/citations/marks";
import { markdownToTiptap, type MarkdownOptions } from "@/lib/report/markdown-to-tiptap";
import type { PMNode } from "@/lib/documents/sections";

const MARKER_WITH_SPACE_RE = new RegExp(String.raw`\s?` + MARKER_RE.source, "g");

/** Remove citation markers ([[p:S1234abcd.P3]]): for replies the server didn't verify (no CitationReport) and for plain-text uses. */
export function stripCitationMarkers(markdown: string): string {
  return markdown.replace(MARKER_WITH_SPACE_RE, "").replace(LEFTOVER_MARKER_RE, "");
}

/**
 * Blocks for a section body. A generated heading at or above the section's own
 * level would split the section, so headings are pushed below it (capped at 3;
 * a heading that can't go lower becomes a bold paragraph). Never returns an
 * empty list: an empty result is one empty paragraph. `lineBreaks` keeps each
 * line of a paragraph on its own line (scaffolds and fixed front matter, whose
 * fields are written one per line). With `citations` (the server's report on
 * the reply), each verified marker becomes a citation mark on the text it
 * cites (markCitations); without it, markers are stripped.
 */
export function sectionBlocksFromMarkdown(markdown: string, sectionLevel: number, opts: MarkdownOptions & { citations?: CitationReport | null } = {}): PMNode[] {
  const { citations, ...md } = opts;
  const doc = markdownToTiptap((citations ? markdown : stripCitationMarkers(markdown)).trim(), md);
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
  const blocks = citations ? markCitations(out, citations) : out;
  return blocks.length ? blocks : [{ type: "paragraph" }];
}
