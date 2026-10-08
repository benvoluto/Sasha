// Restructure to type (PLAN §6.7; phase6-spec.md §3): split a document into
// parts (a heading and its body; text before the first heading is one part),
// and rebuild it in a target type's outline order from a mapping a person has
// approved. Pure and client-safe: restructure.plan (server) chunks and hashes
// with the same functions the editor (apply-workflow-change.ts) uses to apply.
//
// Applying:
//   1. drift: the block count or any block's hash differs from the plan's, so
//      the caller refuses (the document changed since it was planned);
//   2. target sections in outline order, each filled with its rows' parts in
//      document order. A part whose own heading reads as the section's heading
//      becomes the section heading (keeping its sectionId, taking the section's
//      spec key and level); otherwise the section heading is created once and
//      each part's heading is kept, word for word, one level below it (at most
//      level 3). Bodies move verbatim;
//   3. sections nothing maps to are added with their scaffold (or an empty
//      paragraph);
//   4. text before the first heading with no target stays at the top;
//   5. other parts with no target go, verbatim, under a final untagged
//      “Content to place” heading.
// Nothing is ever dropped: every text node of the input appears in the output.

import { normalizeHeading } from "@/catalog/outline-merge";
import { headingNode, randomSectionId, sectionNodes } from "@/catalog/outline";
import { sortedSections, type SectionSummary } from "@/catalog/schema";
import { nodeText, type PMNode } from "@/lib/documents/sections";
import { NO_HOME_HEADING, type RestructurePlan } from "./contract";

/** Headings at this level or above start a new part; deeper sub-headings stay in their part's body. */
export const MAX_CHUNK_LEVEL = 3;
const EXCERPT_CHARS = 280;

export type RestructureChunk = {
  /** Top-level node indexes (inclusive). */
  from: number;
  to: number;
  /** The part's heading text, or null for the text before the first heading. */
  heading: string | null;
  level: number | null;
  /** The body's text (without the heading), for the model and the mapping table. */
  text: string;
  excerpt: string;
};

const levelOf = (n: PMNode) => Number(n.attrs?.level ?? 1);
const isBoundary = (n: PMNode) => n.type === "heading" && levelOf(n) <= MAX_CHUNK_LEVEL;
const MEDIA = new Set(["table", "image", "horizontalRule"]);
const hasMedia = (n: PMNode): boolean => MEDIA.has(n.type) || (n.content ?? []).some(hasMedia);
/** A node with no text and nothing else to show (an empty paragraph). */
const isBlank = (n: PMNode) => !nodeText(n).trim() && !hasMedia(n);

/** FNV-1a over a block's type and text: a short, stable fingerprint for the drift check. */
export function blockHash(node: PMNode): string {
  const s = `${node.type}\u0000${nodeText(node)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function blockHashes(doc: PMNode): string[] {
  return (doc.content ?? []).map(blockHash);
}

/** The document's parts in order. A preamble of blank paragraphs only is not a part. */
export function restructureChunks(doc: PMNode): RestructureChunk[] {
  const nodes = doc.content ?? [];
  const out: RestructureChunk[] = [];
  let start = 0;
  const push = (from: number, to: number) => {
    if (to < from) return;
    const first = nodes[from];
    const headed = isBoundary(first);
    const body = nodes.slice(headed ? from + 1 : from, to + 1);
    if (!headed && body.every(isBlank)) return;
    const text = body.map(nodeText).join("").replace(/\n{3,}/g, "\n\n").trim();
    out.push({
      from,
      to,
      heading: headed ? nodeText(first).trim() : null,
      level: headed ? levelOf(first) : null,
      text,
      excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text,
    });
  };
  nodes.forEach((n, i) => {
    if (i > start && isBoundary(n)) {
      push(start, i - 1);
      start = i;
    }
  });
  if (nodes.length) push(start, nodes.length - 1);
  return out;
}

export type RestructureResult = {
  doc: PMNode;
  /** Parts placed in a target section. */
  moved: number;
  /** Target sections added empty. */
  added: number;
  /** Parts kept under “Content to place”. */
  noHome: number;
  /** True when the document no longer matches the plan; `doc` is then the input, unchanged. */
  drift: boolean;
};

export type TargetSection = Pick<SectionSummary, "key" | "heading" | "order"> & Partial<Pick<SectionSummary, "level" | "scaffold">>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A part's heading kept word for word at `level`, no longer tagged with a spec key. */
function keptHeading(node: PMNode, level: number, newId: () => string): PMNode {
  const c = clone(node);
  c.attrs = { ...(c.attrs ?? {}), level, specKey: null, sectionId: c.attrs?.sectionId || newId() };
  return c;
}

export function applyRestructurePlan(doc: PMNode, plan: RestructurePlan, sections: TargetSection[], newId: () => string = randomSectionId): RestructureResult {
  const nodes = doc.content ?? [];
  const hashes = nodes.map(blockHash);
  if (hashes.length !== plan.blockHashes.length || hashes.some((h, i) => h !== plan.blockHashes[i])) return { doc, moved: 0, added: 0, noHome: 0, drift: true };

  const outline = sortedSections(sections);
  const keys = new Set(outline.map((s) => s.key));
  const rows = [...plan.rows].sort((a, b) => a.from - b.from);
  const covered = new Set<number>();
  for (const r of rows) for (let i = r.from; i <= r.to; i++) covered.add(i);
  const headedRow = (r: (typeof rows)[number]) => r.heading !== null && isBoundary(nodes[r.from] ?? { type: "paragraph" });
  const bodyOf = (r: (typeof rows)[number]) => nodes.slice(headedRow(r) ? r.from + 1 : r.from, r.to + 1).map(clone);

  const content: PMNode[] = [];
  let moved = 0;
  let added = 0;

  // Text before the first heading with no home stays at the top.
  const preamble = rows.filter((r) => r.heading === null && (r.target === null || !keys.has(r.target)));
  for (const r of preamble) content.push(...bodyOf(r));

  for (const s of outline) {
    const mine = rows.filter((r) => r.target === s.key);
    if (!mine.length) {
      content.push(...sectionNodes(s, newId));
      added++;
      continue;
    }
    const level = s.level ?? 2;
    const want = normalizeHeading(s.heading);
    const own = mine.find((r) => headedRow(r) && normalizeHeading(r.heading ?? "") === want);
    if (own) {
      const h = clone(nodes[own.from]);
      h.attrs = { ...(h.attrs ?? {}), level, specKey: s.key, sectionId: h.attrs?.sectionId || newId() };
      content.push(h);
    } else {
      content.push(headingNode(s, newId()));
    }
    for (const r of mine) {
      if (r !== own && headedRow(r)) content.push(keptHeading(nodes[r.from], Math.min(level + 1, MAX_CHUNK_LEVEL), newId));
      content.push(...bodyOf(r));
      moved++;
    }
  }

  // Everything else with no home, verbatim, under one untagged heading at the end.
  const homeless = rows.filter((r) => r.heading !== null && (r.target === null || !keys.has(r.target)));
  const stray = nodes.map((n, i) => ({ n, i })).filter(({ n, i }) => !covered.has(i) && !isBlank(n));
  if (homeless.length || stray.length) {
    content.push({ type: "heading", attrs: { level: 2, sectionId: newId(), specKey: null }, content: [{ type: "text", text: NO_HOME_HEADING }] });
    const pieces = [...homeless.map((r) => ({ at: r.from, nodes: nodes.slice(r.from, r.to + 1) })), ...stray.map(({ n, i }) => ({ at: i, nodes: [n] }))].sort((a, b) => a.at - b.at);
    for (const p of pieces) for (const n of p.nodes) content.push(isBoundary(n) ? keptHeading(n, Math.max(levelOf(n), 3), newId) : clone(n));
  }

  return { doc: { ...doc, content: content.length ? content : [{ type: "paragraph" }] }, moved, added, noHome: homeless.length, drift: false };
}
