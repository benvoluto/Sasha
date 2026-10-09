// Turning verified [[p:ID]] markers into citation marks (phase7-spec.md §2.3).
// Pure and client-safe: sectionBlocksFromMarkdown calls it on the converted
// blocks when the server sent a CitationReport, and the selection rewrite does
// the same with its own blocks.
//
// Each marker cites the text before it: back to the previous sentence end (the
// same boundary pages.ts splits passages at) or the previous group of markers
// in the same textblock, whichever is later. Markers written together cite the
// same span, each with its own mark. The marker text is removed; a marker with
// nothing before it, or an id the report doesn't list, is removed without a mark.

import type { PMNode } from "@/lib/documents/sections";
import { CITATION_MARK, parseMarkers, type CitationAttrs, type CitationReport } from "./contract";

type Mark = NonNullable<PMNode["marks"]>[number];

/** Where a sentence may end (pages.ts's SENTENCE_END). */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g;

/** Stands for an inline node that isn't text (a hard break, an image) in a textblock's flattened text. */
const OBJECT = "￼";

const isTextblock = (n: PMNode) => !!n.content?.length && n.content.every((c) => c.type === "text" || c.type === "hardBreak" || c.type === "image");

/** The mark for a kept passage id. */
export function passageCitationMark(id: string, report: CitationReport): Mark | null {
  const info = report.passages[id];
  if (!info) return null;
  const attrs: CitationAttrs = { kind: "passage", passageId: id, sourceId: info.sourceId, dataTableId: null, quote: info.quote, verified: true };
  return { type: CITATION_MARK, attrs };
}

/** One textblock with its markers turned into marks; unchanged (same object) when it has none. */
function markTextblock(block: PMNode, report: CitationReport): PMNode {
  const inline = block.content ?? [];
  const full = inline.map((c) => (c.type === "text" ? (c.text ?? "") : OBJECT)).join("");
  const markers = parseMarkers(full);
  if (!markers.length) return block;

  // Each character of the text without markers, with the inline node it came from.
  const owner: number[] = [];
  let clean = "";
  const groups: Array<{ at: number; ids: string[] }> = [];
  const nodeAt: number[] = [];
  inline.forEach((c, i) => {
    const len = c.type === "text" ? (c.text ?? "").length : 1;
    for (let k = 0; k < len; k++) nodeAt.push(i);
  });
  let cursor = 0;
  const keep = (to: number) => {
    for (let i = cursor; i < to; i++) {
      clean += full[i];
      owner.push(nodeAt[i]);
    }
  };
  for (const m of markers) {
    const at = m.index;
    keep(at);
    // The space before a marker goes with it ("rose 12% [[p:x]]." reads "rose 12%.").
    while (clean.length && /[ \t]/.test(clean[clean.length - 1])) {
      clean = clean.slice(0, -1);
      owner.pop();
    }
    const id = m.passageId;
    const last = groups[groups.length - 1];
    if (last && last.at === clean.length) last.ids.push(id);
    else groups.push({ at: clean.length, ids: [id] });
    cursor = at + m.length;
    // A marker that opens the block leaves no space before the text.
    if (!clean.length) while (cursor < full.length && /[ \t]/.test(full[cursor])) cursor++;
  }
  keep(full.length);

  // Sentence starts, in the text without markers; an inline object also ends a sentence.
  const starts = [0];
  for (const m of clean.matchAll(SENTENCE_END)) starts.push((m.index ?? 0) + m[0].length);
  for (let i = 0; i < clean.length; i++) if (clean[i] === OBJECT) starts.push(i + 1);
  starts.sort((a, b) => a - b);

  // The citation marks each character gets.
  const cites: Mark[][] = clean.split("").map(() => []);
  let prevEnd = 0;
  for (const g of groups) {
    let end = g.at;
    while (end > 0 && /\s/.test(clean[end - 1])) end--;
    let start = Math.max(prevEnd, ...starts.filter((s) => s < end));
    while (start < end && /\s/.test(clean[start])) start++;
    prevEnd = g.at;
    if (start >= end) continue;
    const marks = [...new Set(g.ids)].map((id) => passageCitationMark(id, report)).filter((m): m is Mark => !!m);
    for (let i = start; i < end; i++) if (clean[i] !== OBJECT) cites[i].push(...marks);
  }

  // Rebuild the inline content: runs of characters from the same node with the same citations.
  const out: PMNode[] = [];
  let i = 0;
  while (i < clean.length) {
    const node = inline[owner[i]];
    if (node.type !== "text") {
      out.push(node);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < clean.length && owner[j] === owner[i] && sameMarks(cites[j], cites[i])) j++;
    const marks = [...(node.marks ?? []), ...cites[i]];
    out.push({ ...node, text: clean.slice(i, j), ...(marks.length ? { marks } : {}) });
    i = j;
  }
  // Merge neighbouring pieces split by a removed marker that ended up with the same marks.
  const merged: PMNode[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === "text" && n.type === "text" && sameMarks(prev.marks ?? [], n.marks ?? [])) merged[merged.length - 1] = { ...prev, text: (prev.text ?? "") + (n.text ?? "") };
    else merged.push(n);
  }
  const content = merged.filter((n) => n.type !== "text" || n.text);
  const next: PMNode = { ...block, content };
  if (!content.length) delete next.content;
  return next;
}

const sameMarks = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((m, k) => m.type === b[k].type && JSON.stringify(m.attrs ?? null) === JSON.stringify(b[k].attrs ?? null));

/**
 * Pure: `blocks` with every [[p:ID]] marker removed and, for ids in
 * `report.passages`, a citation mark on the text the marker cites (other marks
 * kept). Walks every textblock, including list items and table cells.
 */
export function markCitations(blocks: PMNode[], report: CitationReport): PMNode[] {
  const walk = (n: PMNode): PMNode => {
    if (isTextblock(n)) return markTextblock(n, report);
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return blocks.map(walk);
}
