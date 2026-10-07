// Splits source documents into short, citable passages with stable ids, and
// checks that what an agent quotes actually appears in the passage it cites.
// Citation checking is the main guard against an agent inventing evidence.

import { z } from "zod";
import { normalizeForMatching } from "@/lib/text-match";

/** One source document's text, as split from the extraction. */
export type SourceDocument = { doc_id: string; doc_type: string; text: string };

/** A model's citation: the passage it relies on and the words it quotes. */
export const EvidenceRef = z.object({
  passage_id: z.string().min(1),
  quote: z.string().min(1),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export type Passage = { passage_id: string; doc_id: string; doc_type: string; text: string };

/** Target passage length. Long enough for context, short enough to cite precisely. */
const PASSAGE_CHARS = 600;

/** Sentence-ish split that tolerates abbreviations well enough for citation. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/).filter((s) => s.trim());
}

/** Passage ids look like "D2.P5": document index 2, passage 5. */
export function toPassages(documents: SourceDocument[]): Passage[] {
  const out: Passage[] = [];
  documents.forEach((doc, d) => {
    let buf = "";
    let p = 0;
    const flush = () => {
      if (!buf.trim()) return;
      out.push({ passage_id: `D${d}.P${p++}`, doc_id: doc.doc_id, doc_type: doc.doc_type, text: buf.trim() });
      buf = "";
    };
    for (const s of sentences(doc.text)) {
      if (buf && buf.length + s.length > PASSAGE_CHARS) flush();
      buf += (buf ? " " : "") + s;
    }
    flush();
  });
  return out;
}

const canon = (s: string) => normalizeForMatching(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type CitationCheck = {
  total: number;
  verified: number;
  /** Cited passage ids that do not exist. */
  unknownPassages: string[];
  /** Quotes not found in the passage they cite. */
  unsupportedQuotes: Array<{ passage_id: string; quote: string }>;
};

/**
 * A citation is verified when the passage exists and the quote (ignoring case,
 * punctuation and spacing) appears in it. A quote that appears in a DIFFERENT
 * passage still fails: the reviewer is sent to the cited passage.
 */
export function checkCitations(refs: EvidenceRef[], passages: Passage[]): CitationCheck {
  const byId = new Map(passages.map((p) => [p.passage_id, canon(p.text)]));
  const result: CitationCheck = { total: refs.length, verified: 0, unknownPassages: [], unsupportedQuotes: [] };
  for (const r of refs) {
    const text = byId.get(r.passage_id.trim());
    if (text === undefined) {
      result.unknownPassages.push(r.passage_id);
      continue;
    }
    const q = canon(r.quote);
    if (q && text.includes(q)) result.verified++;
    else result.unsupportedQuotes.push({ passage_id: r.passage_id, quote: r.quote });
  }
  return result;
}

/**
 * Best-effort removal of the student's and school's names before the packet
 * leaves the app. This is a backstop, not de-identification: test with
 * de-identified files, and keep dates of birth, addresses and other names out
 * of the source documents.
 */
export function redact(text: string, names: { student?: string; school?: string }): string {
  let out = text;
  const replaceAll = (needle: string, repl: string) => {
    const n = needle.trim();
    if (n.length < 3) return;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`(?<!\\w)${escaped}(?:'s)?(?!\\w)`, "gi"), (m) => (m.toLowerCase().endsWith("'s") ? `${repl}'s` : repl));
  };
  if (names.school) replaceAll(names.school, "[School]");
  if (names.student) {
    replaceAll(names.student, "[Student]");
    // Then each part of the name on its own ("Jordan", "Smith").
    for (const part of names.student.split(/\s+/)) replaceAll(part, "[Student]");
  }
  return out;
}
