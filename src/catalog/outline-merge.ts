// Planning a type's outline merge into a document that already has text
// (PLAN §6.3, §6.7; phase4-spec.md §3.6). Pure and client-safe; the editor
// applies the plan as one transaction (src/components/editor/apply-outline.ts).
//
// Over the document's top-level nodes:
//   1. headings that already carry one of the type's spec keys stay as they are;
//   2. other headings (level ≤ 3) whose text matches a missing section's heading
//      (ignoring case, spacing, punctuation and a leading number such as "2." or
//      "II.") are tagged with that section's key;
//   3. each section still missing is inserted after the body of the nearest
//      section before it in outline order that the document has; with none
//      before it, before the first section the document has; with none at all,
//      at the end.
// Nothing is deleted, moved or rewritten.

import { nodeText, type PMNode } from "@/lib/documents/sections";
import { sortedSections, type SectionSummary } from "./schema";

type MergeSection = Pick<SectionSummary, "key" | "heading" | "order"> & Partial<Pick<SectionSummary, "level">>;

export type OutlineMergePlan<S extends MergeSection = MergeSection> = {
  /** Headings (by top-level index) to give a spec key. */
  tag: Array<{ index: number; specKey: string }>;
  /** Sections to insert after the top-level node at `afterIndex` (-1: at the start), in outline order; sorted by `afterIndex`. */
  insert: Array<{ afterIndex: number; sections: S[] }>;
  /** Whether anything was placed relative to a section the document has (false: nothing inserted, or all appended at the end). */
  inOrder: boolean;
};

const MAX_TAG_LEVEL = 3;
const LEADING_NUMBER = /^\s*(?:\d+(?:\.\d+)*[.):]?|[ivxlcdm]+[.)]|[a-z][.)])\s+/i;

/** A heading's text for matching: lower-cased, punctuation and extra spacing removed. */
export function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The normalized forms a heading matches under: as written, and without a leading number. */
function headingForms(text: string): string[] {
  const forms = [normalizeHeading(text)];
  const stripped = text.replace(LEADING_NUMBER, "");
  if (stripped !== text) forms.push(normalizeHeading(stripped));
  return forms.filter(Boolean);
}

const levelOf = (n: PMNode) => Number(n.attrs?.level ?? 1);
const specKeyOf = (n: PMNode) => (n.attrs?.specKey ? String(n.attrs.specKey) : null);

export function planOutlineMerge<S extends MergeSection>(doc: PMNode, sections: S[]): OutlineMergePlan<S> {
  const nodes = doc.content ?? [];
  const outline = sortedSections(sections);
  const keys = new Set(outline.map((s) => s.key));
  /** Section key → top-level index of its heading. */
  const at = new Map<string, number>();
  nodes.forEach((n, index) => {
    const key = specKeyOf(n);
    if (n.type === "heading" && key && keys.has(key) && !at.has(key)) at.set(key, index);
  });

  // 2. Tag untagged headings that read like a missing section.
  const tag: OutlineMergePlan["tag"] = [];
  const formsByKey = new Map(outline.map((s) => [s.key, new Set(headingForms(s.heading))]));
  nodes.forEach((n, index) => {
    if (n.type !== "heading" || levelOf(n) > MAX_TAG_LEVEL) return;
    const key = specKeyOf(n);
    if (key && keys.has(key)) return;
    const forms = headingForms(nodeText(n));
    const match = outline.find((s) => !at.has(s.key) && forms.some((f) => formsByKey.get(s.key)!.has(f)));
    if (!match) return;
    at.set(match.key, index);
    tag.push({ index, specKey: match.key });
  });

  // 3. Place the rest.
  const missing = outline.filter((s) => !at.has(s.key));
  if (!missing.length) return { tag, insert: [], inOrder: false };
  const groups = new Map<number, S[]>();
  let inOrder = false;
  const firstPresent = outline.find((s) => at.has(s.key));
  for (const s of missing) {
    const pos = outline.indexOf(s);
    const before = outline
      .slice(0, pos)
      .reverse()
      .find((p) => at.has(p.key));
    let afterIndex: number;
    if (before) {
      afterIndex = endOfSection(nodes, at.get(before.key)!);
      inOrder = true;
    } else if (firstPresent) {
      afterIndex = at.get(firstPresent.key)! - 1;
      inOrder = true;
    } else {
      afterIndex = nodes.length - 1;
    }
    groups.set(afterIndex, [...(groups.get(afterIndex) ?? []), s]);
  }
  const insert = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([afterIndex, list]) => ({ afterIndex, sections: list }));
  return { tag, insert, inOrder };
}

/** Index of the last top-level node in the section headed at `index` (before the next heading of the same or a higher level). */
function endOfSection(nodes: PMNode[], index: number): number {
  const level = levelOf(nodes[index]);
  for (let i = index + 1; i < nodes.length; i++) if (nodes[i].type === "heading" && levelOf(nodes[i]) <= level) return i - 1;
  return nodes.length - 1;
}
