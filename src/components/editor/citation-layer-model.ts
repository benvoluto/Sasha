// The pure half of the citation layer (citation-layer.tsx): finding the cited
// runs in a ProseMirror document and numbering them by first appearance, where
// the reference numbers go, the hover's status line and excerpt, and the
// section body serialized with its citations as [[p:ID]] markers (so a rewrite
// keeps them). No DOM; unit-tested over a schema built from the document's
// extensions.

import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { CITATION_MARK, citationAttrs, citationKey, type CitationAttrs, type ResolvedReference } from "@/lib/citations/contract";
import { findQuote, quoteKey } from "@/lib/citations/quote";
import { canon } from "@/lib/sources/passages";

/** A maximal stretch of one textblock carrying the same citation. */
export type CitationRun = { key: string; attrs: CitationAttrs; from: number; to: number };

const citationsOf = (marks: readonly Mark[]) =>
  marks.flatMap((m) => {
    if (m.type.name !== CITATION_MARK) return [];
    const attrs = citationAttrs(m.attrs);
    const key = citationKey(attrs);
    return key ? [{ key, attrs, mark: m }] : [];
  });

/** Every cited run, in document order (by where it starts, then by key for runs that start together). */
export function citationRuns(doc: PMNode): CitationRun[] {
  const out: CitationRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const open = new Map<string, CitationRun>();
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      const here = new Set<string>();
      for (const c of citationsOf(child.marks)) {
        here.add(c.key);
        const run = open.get(c.key);
        if (run && run.to === at) run.to = at + child.nodeSize;
        else {
          const fresh = { key: c.key, attrs: c.attrs, from: at, to: at + child.nodeSize };
          open.set(c.key, fresh);
          out.push(fresh);
        }
      }
      for (const k of [...open.keys()]) if (!here.has(k)) open.delete(k);
    });
    return false;
  });
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Reference numbers by first appearance (collectCitations' order). */
export function numberRuns(runs: CitationRun[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const r of runs) if (!numbers.has(r.key)) numbers.set(r.key, numbers.size + 1);
  return numbers;
}

/** Where the numbers go: one widget position per run end, its keys in number order. */
export function refWidgets(runs: CitationRun[], numbers: Map<string, number>): Array<{ pos: number; keys: string[] }> {
  const at = new Map<number, string[]>();
  for (const r of runs) {
    const keys = at.get(r.to) ?? [];
    if (!keys.includes(r.key)) keys.push(r.key);
    at.set(r.to, keys);
  }
  return [...at.entries()].sort((a, b) => a[0] - b[0]).map(([pos, keys]) => ({ pos, keys: keys.sort((a, b) => (numbers.get(a) ?? 0) - (numbers.get(b) ?? 0)) }));
}

/** The runs the caret is in: after the run's first character, up to and including its end. */
export function runsAt(runs: CitationRun[], pos: number): CitationRun[] {
  return runs.filter((r) => pos > r.from && pos <= r.to);
}

/** The run with this key that ends at `pos`, or contains it. */
export function runFor(runs: CitationRun[], key: string, pos: number): CitationRun | null {
  return runs.find((r) => r.key === key && r.to === pos) ?? runs.find((r) => r.key === key && pos >= r.from && pos <= r.to) ?? null;
}

/** The citation mark instance on the run (for removing exactly it). */
export function runMark(doc: PMNode, run: CitationRun): Mark | null {
  let found: Mark | null = null;
  doc.nodesBetween(run.from, run.to, (node) => {
    if (found || !node.isText) return !found;
    found = citationsOf(node.marks).find((c) => c.key === run.key)?.mark ?? null;
    return false;
  });
  return found;
}

/** Keys present in `next` that weren't in `prev` (a citation was added: re-run the lint). */
export function addedKeys(prev: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  return [...next].filter((k) => !prev.has(k));
}

// --- Words on screen ------------------------------------------------------------

/** The caret hint: the shortcut on a keyboard, the tap on a touch screen (no Alt key there). */
export const hintText = (n: number, input: "mac" | "keyboard" | "touch") =>
  input === "touch" ? `Source ${n}, tap [${n}] for details` : `Source ${n}, ${input === "mac" ? "Option" : "Alt"}+Enter to open details`;
export const announcement = (title: string) => `Cited: ${title}`;

/** The hover's status line: what the lint found, or how the citation was made. */
export function statusText(
  ref: (Pick<ResolvedReference, "status" | "kind"> & { quote?: string | null }) | null | undefined,
  attrs: Pick<CitationAttrs, "verified" | "kind"> & { quote?: string | null },
): string {
  const what = attrs.kind === "table" ? "table" : "source";
  switch (ref?.status) {
    case "unlinked":
      return `This ${what === "table" ? "table's source" : "source"} was unlinked from the document.`;
    case "deleted":
      return `This ${what} was deleted.`;
    case "missing":
      return "This source was re-read; the passage no longer exists.";
    default:
      if (!ref) return "Checking the source…";
      // The server keeps the mark's quote only when the passage contains it; the
      // mark's own `verified` is stored content and can't vouch for it.
      if (quoteKey(attrs.quote) && ref.quote === null) return "The quoted words are not in this passage.";
      return attrs.verified ? "Checked against the source when it was added." : "Not checked against the source.";
  }
}

/** Pure: the keys of runs in the editor that the last lint returned no reference for. */
export function missingKeys(runs: ReadonlyArray<Pick<CitationRun, "key">>, refs: ReadonlyMap<string, unknown>): string[] {
  return [...new Set(runs.map((r) => r.key))].filter((k) => !refs.has(k));
}

export const isStale = (ref: Pick<ResolvedReference, "status"> | null | undefined) => !!ref && ref.status !== "ok";

/** The title line for a reference, or a fallback from the mark while the lint is loading. */
export function referenceTitle(ref: Pick<ResolvedReference, "kind" | "sourceTitle" | "tableName"> | null | undefined, attrs: Pick<CitationAttrs, "kind">): string {
  if (!ref) return attrs.kind === "table" ? "Data table" : "Source";
  return ref.kind === "table" && ref.tableName ? `Table “${ref.tableName}”, ${ref.sourceTitle}` : ref.sourceTitle;
}

/**
 * The excerpt split around the quote, when the quote is in it (tolerant of
 * case, punctuation and spacing, and by whole words, as the server checked
 * it); [excerpt] otherwise.
 */
export function quoteParts(excerpt: string, quote: string | null): [string] | [string, string, string] {
  const key = quoteKey(quote);
  if (!key) return [excerpt];
  // Map each canon character back to the excerpt, so the highlight lands on the original text.
  let flat = "";
  const back: number[] = [];
  let space = true;
  for (let i = 0; i < excerpt.length; i++) {
    const c = canon(excerpt[i]);
    if (c) {
      for (const ch of c) {
        flat += ch;
        back.push(i);
      }
      space = false;
    } else if (!space) {
      flat += " ";
      back.push(i);
      space = true;
    }
  }
  const at = findQuote(flat, key);
  if (at < 0) return [excerpt];
  const start = back[at];
  const end = back[at + key.text.length - 1] + 1;
  return [excerpt.slice(0, start), excerpt.slice(start, end), excerpt.slice(end)];
}

// --- Serializing citations as markers ------------------------------------------------

/**
 * The text between `from` and `to` as textBetween(from, to, "\n\n") reads it,
 * with a bare [[p:ID]] marker after each run of a passage citation (table
 * citations are left out: they aren't passages). A rewrite sent this text gets
 * its citations back as markers, which the server checks again.
 */
export function textWithMarkers(doc: PMNode, from: number, to: number): string {
  let text = "";
  let first = true;
  let open: string[] = [];
  const close = (keep: Set<string>) => {
    for (const id of open) if (!keep.has(id)) text += `[[p:${id}]]`;
    open = open.filter((id) => keep.has(id));
  };
  doc.nodesBetween(
    from,
    to,
    (node, pos) => {
      if (node.isBlock && (node.isTextblock || (node.isLeaf && node.type.spec.leafText))) {
        close(new Set());
        if (first) first = false;
        else text += "\n\n";
      }
      if (node.isText) {
        const ids = new Set(citationsOf(node.marks).flatMap((c) => (c.attrs.kind === "passage" && c.attrs.passageId ? [c.attrs.passageId] : [])));
        close(ids);
        text += (node.text ?? "").slice(Math.max(from, pos) - pos, to - pos);
        for (const id of ids) if (!open.includes(id)) open.push(id);
      } else if (node.isLeaf && node.isInline) {
        close(new Set());
        text += node.type.spec.leafText ? node.type.spec.leafText(node) : "";
      }
      return true;
    },
    0,
  );
  close(new Set());
  return text;
}
