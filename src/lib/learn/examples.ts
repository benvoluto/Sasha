// Reading the examples a type is learned from (PLAN §6.11). A source is read
// through the team-checked sources store (it must have finished reading: its
// extracted text, or its passages in order when there is none); a document in
// Sasha is read as Markdown with its headings. Each example is capped, and the
// caps shrink when there are several so the total stays under
// LEARN_MAX_TOTAL_CHARS.
//
// Examples stay team sources: their text goes to the model (as delimited
// data) and back to the author's review screen, and nowhere else.
//
// Server-only (stores); the text helpers are pure and unit-tested.

import { getDocument } from "@/lib/documents/store";
import { nodeText, wordCount, type PMNode } from "@/lib/documents/sections";
import { getSource, listPassages } from "@/lib/sources/store";
import { LEARN_MAX_EXAMPLE_CHARS, LEARN_MAX_TOTAL_CHARS, type LearnExampleRef, type LearnExampleView } from "./contract";

/** A refusal the routes turn into a status (an example that is not the team's, still reading, or empty). */
export class LearnInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** Sources that have finished reading. A partial read is still a usable example. */
const READ = new Set(["ready", "partial"]);

/** A document's body as Markdown: headings as `#` lines at their level, every other block as its text. */
export function documentMarkdown(doc: PMNode | null | undefined): string {
  const blocks = (doc?.content ?? []).map((n) => {
    const text = nodeText(n).trim();
    if (!text) return "";
    if (n.type === "heading") return `${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${text.replace(/\s+/g, " ")}`;
    if (n.type === "bulletList" || n.type === "orderedList") {
      return (n.content ?? [])
        .map((li, i) => `${n.type === "orderedList" ? `${i + 1}.` : "-"} ${nodeText(li).trim().replace(/\n+/g, " ")}`)
        .join("\n");
    }
    return text;
  });
  return blocks.filter(Boolean).join("\n\n");
}

/**
 * HTML marked up so its readable text keeps the structure: each heading starts
 * with its Markdown `#`s, and code blocks are fenced so a comment line inside
 * one ("# Handle a matched regex") is not read as a heading. Used by the
 * evaluation harness on fetched HTML examples.
 */
export function markHtmlStructure(html: string): string {
  return html
    .replace(/<h([1-6])(\b[^>]*)>/gi, (_m, n: string, a: string) => `<h${n}${a}>${"#".repeat(Number(n))} `)
    .replace(/<pre(\b[^>]*)>/gi, "<pre$1>\n```\n")
    .replace(/<\/pre>/gi, "\n```\n</pre>");
}

/** The Markdown headings in a text, in order (ATX `#` lines; a closing run of #s is dropped). */
export function markdownHeadings(text: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[2].trim()) out.push({ level: m[1].length, text: m[2].replace(/\*\*|__/g, "").trim() });
  }
  return out;
}

/** The per-example cap for `n` examples. */
export const exampleCap = (n: number) => Math.min(LEARN_MAX_EXAMPLE_CHARS, Math.floor(LEARN_MAX_TOTAL_CHARS / Math.max(1, n)));

/** Cut at a paragraph (or line) break near the cap rather than mid-sentence. */
export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const cut = text.slice(0, cap);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
  return { text: (at > cap * 0.8 ? cut.slice(0, at) : cut).trimEnd(), truncated: true };
}

type Read = { title: string; text: string };

async function readSource(teamId: string, sourceId: string): Promise<Read> {
  const s = await getSource(teamId, sourceId);
  if (!s) throw new LearnInputError("One of the examples isn't in your library.", 404);
  const title = s.title || s.filename || s.url || "Untitled source";
  if (!READ.has(s.extraction_status)) throw new LearnInputError(`“${title}” hasn't finished reading yet. Try again when it's ready.`, 409);
  let text = (s.extracted_text ?? "").trim();
  if (!text) text = ((await listPassages(teamId, sourceId)) ?? []).map((p) => p.text).join("\n\n").trim();
  return { title, text };
}

async function readDocument(teamId: string, documentId: string): Promise<Read> {
  const d = await getDocument(teamId, documentId);
  if (!d) throw new LearnInputError("One of the examples isn't one of your team's documents.", 404);
  const title = d.title.trim() || "Untitled document";
  return { title, text: documentMarkdown(d.content_json) };
}

/**
 * The examples as the model and the review read them, in request order.
 * Throws LearnInputError for an example the team can't read, one still being
 * read, or one with no text.
 */
export async function readExamples(teamId: string, refs: LearnExampleRef[]): Promise<LearnExampleView[]> {
  const cap = exampleCap(refs.length);
  const out: LearnExampleView[] = [];
  for (const [index, ref] of refs.entries()) {
    const read = ref.kind === "source" ? await readSource(teamId, ref.sourceId) : await readDocument(teamId, ref.documentId);
    if (!read.text) throw new LearnInputError(`“${read.title}” has no text to learn from.`, 400);
    const { text, truncated } = capText(read.text, cap);
    out.push({ index, ref, title: read.title, words: wordCount(read.text), headings: markdownHeadings(text), text, truncated });
  }
  return out;
}

/** Duplicate references (the same source picked twice) would count as two agreeing examples. */
export function uniqueRefs(refs: LearnExampleRef[]): LearnExampleRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const id = r.kind === "source" ? `s:${r.sourceId}` : `d:${r.documentId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
