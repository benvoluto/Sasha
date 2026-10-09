// "Cite sources" in place (phase7-spec.md §2.4): the reply's verified markers
// become citation marks on the section's EXISTING text, so nothing the plain
// text round trip can't carry (tables and their data-table attrs, the table
// source line and its citation, links, underline, highlight, images) is lost.
// The reply is converted as a rewrite would be, then its words are lined up
// with the document's, letter by letter, and each cited run is mapped back to
// document positions. Pure apart from the ProseMirror nodes it reads.

import type { Node as PMNode } from "@tiptap/pm/model";
import { CITATION_MARK, citationAttrs, type CitationAttrs, type CitationReport } from "@/lib/citations/contract";
import type { PMNode as JsonNode } from "@/lib/documents/sections";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";

/** A citation to add: document positions and the mark's attrs. */
export type PlacedCitation = { from: number; to: number; attrs: CitationAttrs };

/** Letters and digits, lower-cased: what the alignment compares (spacing, punctuation and Markdown syntax aside). */
const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** After a mismatch, how far ahead (in letters, both sides together) the alignment looks for the texts to agree again. */
const RESYNC_WINDOW = 64;
/** Letters that must agree for the alignment to count as back in step. */
const RESYNC_RUN = 8;

/** Punctuation that closes a sentence or clause; a cited run takes it along, as markCitations does. */
const TRAILING = /[.!?,;:)\]"'”’…%]/;

/**
 * Pure: for each index of `a`, the index of the same letter in `b`, or -1 when
 * it has none. The texts must be nearly equal (the server's wording guard has
 * passed); returns null when they can't be brought back into step.
 */
export function alignLetters(a: string, b: string): Int32Array | null {
  const map = new Int32Array(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i++] = j++;
      continue;
    }
    let found = false;
    for (let d = 1; d <= RESYNC_WINDOW && !found; d++) {
      for (let di = 0; di <= d; di++) {
        const ii = i + di;
        const jj = j + (d - di);
        if (ii > a.length || jj > b.length) continue;
        const run = Math.min(RESYNC_RUN, a.length - ii, b.length - jj);
        if (run > 0 && a.startsWith(b.slice(jj, jj + run), ii) && (run === RESYNC_RUN || (ii + run === a.length && jj + run === b.length))) {
          i = ii;
          j = jj;
          found = true;
          break;
        }
      }
    }
    if (!found) return null;
  }
  return map;
}

/** The reply's letters, each with the passage citations it carries. */
function replyLetters(blocks: JsonNode[]): { text: string; cites: CitationAttrs[][] } {
  let text = "";
  const cites: CitationAttrs[][] = [];
  const walk = (n: JsonNode) => {
    if (n.type === "text") {
      const on = (n.marks ?? []).filter((m) => m.type === CITATION_MARK).map((m) => citationAttrs(m.attrs));
      for (const c of n.text ?? "") {
        if (!isWordChar(c)) continue;
        text += c.toLowerCase();
        cites.push(on);
      }
      return;
    }
    (n.content ?? []).forEach(walk);
  };
  blocks.forEach(walk);
  return { text, cites };
}

/** The document's letters between `from` and `to`, each with its position; table cells are left out (they take no citations). */
function documentLetters(doc: PMNode, from: number, to: number): { text: string; pos: number[]; inCell: boolean[] } {
  let text = "";
  const pos: number[] = [];
  const inCell: boolean[] = [];
  doc.nodesBetween(from, to, (node, at) => {
    if (!node.isText) return true;
    const start = Math.max(from, at);
    const end = Math.min(to, at + node.nodeSize);
    const $at = doc.resolve(start);
    let cell = false;
    for (let d = $at.depth; d > 0; d--) if (/^table(Cell|Header)$/.test($at.node(d).type.name)) cell = true;
    const s = node.text ?? "";
    for (let p = start; p < end; p++) {
      const c = s[p - at];
      if (!isWordChar(c)) continue;
      text += c.toLowerCase();
      pos.push(p);
      inCell.push(cell);
    }
    return false;
  });
  return { text, pos, inCell };
}

/** Whether the text node at `pos` already carries a citation of this passage. */
function alreadyCited(doc: PMNode, pos: number, passageId: string): boolean {
  const node = doc.nodeAt(pos);
  return !!node?.marks.some((m) => m.type.name === CITATION_MARK && m.attrs.passageId === passageId);
}

/**
 * Pure: the citations to add to the section between `from` and `to` so its
 * text carries the reply's verified markers, or null when the reply's words
 * can't be lined up with the section's (it changed too much). Runs already
 * cited with the same passage, and table cells, are skipped.
 */
export function placeCitations(doc: PMNode, range: { from: number; to: number; level: number }, markdown: string, report: CitationReport): PlacedCitation[] | null {
  const blocks = sectionBlocksFromMarkdown(markdown, range.level, { citations: report });
  const reply = replyLetters(blocks);
  const current = documentLetters(doc, range.from, range.to);
  const map = alignLetters(reply.text, current.text);
  if (!map) return null;

  const out: PlacedCitation[] = [];
  // Open runs, by passage id: the document letters a citation covers so far.
  const open = new Map<string, { attrs: CitationAttrs; first: number; last: number }>();
  const flush = (id: string) => {
    const run = open.get(id);
    open.delete(id);
    if (!run) return;
    const from = current.pos[run.first];
    let to = current.pos[run.last] + 1;
    // Take closing punctuation right after the run along, within the same text.
    while (to < range.to && TRAILING.test(doc.textBetween(to, to + 1, "\n", "\n")) && doc.resolve(to).parent === doc.resolve(from).parent) to++;
    if (!alreadyCited(doc, from, id)) out.push({ from, to, attrs: run.attrs });
  };
  for (let i = 0; i < reply.text.length; i++) {
    const at = map[i];
    const here = new Set<string>();
    if (at >= 0 && !current.inCell[at]) {
      for (const attrs of reply.cites[i]) {
        if (attrs.kind !== "passage" || !attrs.passageId) continue;
        const id = attrs.passageId;
        here.add(id);
        const run = open.get(id);
        // A run continues only within one textblock and over neighbouring letters.
        if (run && at === run.last + 1 && doc.resolve(current.pos[at]).parent === doc.resolve(current.pos[run.last]).parent) run.last = at;
        else {
          flush(id);
          open.set(id, { attrs, first: at, last: at });
        }
      }
    }
    for (const id of [...open.keys()]) if (!here.has(id)) flush(id);
  }
  for (const id of [...open.keys()]) flush(id);
  return out;
}
