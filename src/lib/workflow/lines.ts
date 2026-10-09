// The lines of a document, for the resume Tailor step (After Phase 9, user
// decision 2026-10-09). A line is one paragraph: at the top level, or inside a
// list item or a blockquote (never inside a table). tailor.lines shows the
// model each line with a ref and maps its reply back to the exact text read, so
// a proposed line's `original` is always the document's own words; the editor
// finds the line again by that text when the author applies the change, and
// skips a line that was edited since the run.
//
// Pure functions over the stored JSON, shared by the server and the editor.

import { nodeText, type PMNode } from "@/lib/documents/sections";

export type DocLine = {
  /** "D1"…, in document order; only meaningful for one read of the document. */
  ref: string;
  /** Indexes from the doc's content down to the paragraph. */
  path: number[];
  /** The governing heading's sectionId (the nearest top-level heading above), or null before the first heading. */
  sectionId: string | null;
  heading: string;
  specKey: string | null;
  /** The paragraph's plain text (hard breaks as spaces), trimmed. */
  text: string;
  /** True when the paragraph sits in a list item. */
  inList: boolean;
};

/** Pure: a line's text for comparison (Unicode-normalized, straight quotes, single spaces). */
export function normalizeLine(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const paragraphText = (p: PMNode) => nodeText(p).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

/** Pure: every non-empty line, in document order. */
export function documentLines(doc: PMNode | null | undefined): DocLine[] {
  const out: DocLine[] = [];
  let section: Pick<DocLine, "sectionId" | "heading" | "specKey"> = { sectionId: null, heading: "", specKey: null };
  const visit = (node: PMNode, path: number[], inList: boolean) => {
    if (node.type === "paragraph") {
      const text = paragraphText(node);
      if (text) out.push({ ref: `D${out.length + 1}`, path, ...section, text, inList });
      return;
    }
    if (!["bulletList", "orderedList", "listItem", "blockquote", "taskList", "taskItem"].includes(node.type)) return;
    const list = inList || node.type === "listItem" || node.type === "taskItem";
    (node.content ?? []).forEach((child, i) => visit(child, [...path, i], list));
  };
  (doc?.content ?? []).forEach((node, i) => {
    if (node.type === "heading") {
      const id = node.attrs?.sectionId;
      section = { sectionId: typeof id === "string" && id ? id : null, heading: nodeText(node).trim(), specKey: (node.attrs?.specKey as string | null | undefined) ?? null };
      return;
    }
    visit(node, [i], false);
  });
  return out;
}

/**
 * Pure: the sections a document has, by its top-level headings' sectionIds (as documentLines
 * assigns them), plus null for the part before the first heading, which is always there. A
 * section whose heading is kept but whose lines were all deleted is still here.
 */
export function documentSections(doc: PMNode | null | undefined): Set<string | null> {
  const out = new Set<string | null>([null]);
  for (const node of doc?.content ?? []) {
    if (node.type !== "heading") continue;
    const id = node.attrs?.sectionId;
    out.add(typeof id === "string" && id ? id : null);
  }
  return out;
}

/**
 * Pure: the line a proposed change names, found by its text: in its section (by
 * sectionId), the `occurrence`th line whose text matches `original` (the first
 * unused one for a target stored without it), and none when the section no
 * longer holds `occurrences` such lines, since the repeat it meant can't be told
 * apart; when the section is gone (no heading with its sectionId in `sections`,
 * from documentSections), a match anywhere, but only if exactly one line
 * matches. A section whose heading is kept but whose lines were deleted is not
 * gone: an identical bullet under another employer is never the one meant.
 * Null when the line was edited or removed since the run read it.
 */
export function findLine(
  lines: DocLine[],
  target: { sectionId: string | null; original: string; occurrence?: number; occurrences?: number },
  opts: { sections: ReadonlySet<string | null>; used?: ReadonlySet<string> },
): DocLine | null {
  const used = opts.used ?? new Set<string>();
  const want = normalizeLine(target.original);
  if (!want) return null;
  const same = lines.filter((l) => normalizeLine(l.text) === want);
  const inSection = same.filter((l) => l.sectionId === target.sectionId);
  if (inSection.length) {
    if (target.occurrence === undefined) return inSection.find((l) => !used.has(l.ref)) ?? null;
    if (target.occurrences !== undefined && inSection.length !== target.occurrences) return null;
    const hit = inSection[target.occurrence];
    return hit && !used.has(hit.ref) ? hit : null;
  }
  if (opts.sections.has(target.sectionId)) return null;
  const free = same.filter((l) => !used.has(l.ref));
  return free.length === 1 ? free[0] : null;
}
