// What a document card shows under its title (redesign3-spec.md §5): the first
// line of the body that isn't the title itself. `excerpt` is the first 200
// characters of content_text (store.ts), whose blocks are separated by
// newlines (sections.ts docText), so the first line is the first block:
// usually the first heading of a typed outline, else the opening paragraph.
// Typed outlines start with a heading, so the store also sends `lead`: the
// first text block outside the headings (leadText; the SQL in store.ts
// listDocuments mirrors it), and the subtitle prefers that. Client-safe.
//
// CONTRACT (redesign 3 foundation).

import type { PMNode } from "./sections";

const LEAD_MAX = 200;

const hasText = (n: PMNode): boolean => typeof n.text === "string" || (n.content ?? []).some(hasText);

/** The first block (pre-order) whose own children include text. */
function firstTextBlock(n: PMNode): PMNode | null {
  if ((n.content ?? []).some((c) => typeof c.text === "string")) return n;
  for (const c of n.content ?? []) {
    const hit = firstTextBlock(c);
    if (hit) return hit;
  }
  return null;
}

/** The first text block outside the headings, cut to 200 characters; "" when the document is only headings. */
export function leadText(doc: PMNode | null | undefined): string {
  const top = (doc?.content ?? []).find((n) => n.type !== "heading" && hasText(n));
  const block = top ? firstTextBlock(top) : null;
  return (block?.content ?? []).map((c) => c.text ?? "").join("").slice(0, LEAD_MAX);
}

/** The card subtitle: `lead` when it has text, else the first non-blank line of `excerpt` that differs from `title`; "" when none. */
export function cardSubtitle(title: string, excerpt: string, lead = ""): string {
  if (lead.trim()) return lead.trim();
  const t = title.trim().toLowerCase();
  for (const raw of excerpt.split("\n")) {
    const line = raw.trim();
    if (line && line.toLowerCase() !== t) return line;
  }
  return "";
}

/** The query that opens a document with its notes showing (the modal's Notes tab). */
export const OPEN_NOTES_PARAM = "notes";
/** The query that opens a document on one workflow run (the modal's Workflows tab). */
export const OPEN_RUN_PARAM = "run";
/** The route for a new blank document; the editor replaces it with /d/<id> on the first save. */
export const NEW_DOCUMENT_PATH = "/new";
