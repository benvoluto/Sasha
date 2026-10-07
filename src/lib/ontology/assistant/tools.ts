// The document assistant's read-only tools over one upload group's sources.
// Each tool reads the group's extracted text, split back into one entry per
// source file. Nothing here writes; the governance gate in ./governance.ts
// checks permissions and audits every call.

import { findPhraseMatches } from "@/lib/text-match";
import { splitDocuments } from "@/lib/sources/split";
import type { SourceDocument } from "@/lib/sources/passages";
import { PERMISSIONS } from "../permissions";
import { fetchGroupMetadata } from "../group-metadata";

/** Longest slice of one source returned by read_document. */
export const READ_LIMIT = 12_000;
const MAX_HITS = 20;
const SNIPPET_RADIUS = 160;

export type ToolArgs = Record<string, unknown>;

export type AssistantTool = {
  name: string;
  description: string;
  /** Parameter name → description; all parameters are strings. */
  params: Record<string, string>;
  required: string[];
  permission: string;
  run: (docs: SourceDocument[], args: ToolArgs) => unknown;
};

/** The group's sources, one per file (empty when nothing has been extracted). */
export async function loadSources(groupId: string): Promise<SourceDocument[]> {
  const meta = await fetchGroupMetadata(groupId);
  const text = meta?.geminiProcessing?.extractedContent ?? "";
  return text.trim() ? splitDocuments(groupId, text) : [];
}

/** Find a source by its id ("<group>-2"), index ("2"), or name (case-insensitive). */
export function findDocument(docs: SourceDocument[], ref: string): SourceDocument | undefined {
  const r = ref.trim().toLowerCase();
  if (!r) return undefined;
  return (
    docs.find((d) => d.doc_id.toLowerCase() === r) ??
    (/^\d+$/.test(r) ? docs[Number(r)] : undefined) ??
    docs.find((d) => d.doc_type.toLowerCase() === r) ??
    docs.find((d) => d.doc_type.toLowerCase().includes(r))
  );
}

export function listDocuments(docs: SourceDocument[]) {
  return { documents: docs.map((d, i) => ({ index: i, doc_id: d.doc_id, name: d.doc_type, chars: d.text.length })) };
}

export function readDocument(docs: SourceDocument[], ref: string, offset = 0) {
  const doc = findDocument(docs, ref);
  if (!doc) return { error: `no source matches '${ref}'; call list_documents for the names` };
  const start = Math.max(0, Math.floor(offset));
  const text = doc.text.slice(start, start + READ_LIMIT);
  return {
    doc_id: doc.doc_id,
    name: doc.doc_type,
    offset: start,
    text,
    truncated: start + text.length < doc.text.length,
    total_chars: doc.text.length,
  };
}

export function searchText(docs: SourceDocument[], query: string) {
  const q = query.trim();
  if (!q) return { error: "query is required" };
  const hits: Array<{ doc_id: string; name: string; offset: number; snippet: string }> = [];
  let total = 0;
  for (const doc of docs) {
    for (const m of findPhraseMatches(doc.text, q)) {
      total++;
      if (hits.length >= MAX_HITS) continue;
      const from = Math.max(0, m.index - SNIPPET_RADIUS);
      const to = Math.min(doc.text.length, m.index + m.length + SNIPPET_RADIUS);
      hits.push({ doc_id: doc.doc_id, name: doc.doc_type, offset: m.index, snippet: doc.text.slice(from, to) });
    }
  }
  return { query: q, total, hits };
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export const ASSISTANT_TOOLS: Record<string, AssistantTool> = {
  list_documents: {
    name: "list_documents",
    description: "List the source files uploaded to this document, with their ids and lengths.",
    params: {},
    required: [],
    permission: PERMISSIONS.sourceRead,
    run: (docs) => listDocuments(docs),
  },
  read_document: {
    name: "read_document",
    description: `Read the text of one source file (up to ${READ_LIMIT} characters per call; pass offset to continue).`,
    params: { doc: "The source's doc_id, index, or name from list_documents.", offset: "Optional character offset to start reading at." },
    required: ["doc"],
    permission: PERMISSIONS.sourceRead,
    run: (docs, args) => readDocument(docs, str(args.doc), Number(str(args.offset)) || 0),
  },
  search_text: {
    name: "search_text",
    description: "Search every source for a word or phrase (whole words, case-insensitive). Returns snippets with their source and offset.",
    params: { query: "The word or phrase to find." },
    required: ["query"],
    permission: PERMISSIONS.sourceRead,
    run: (docs, args) => searchText(docs, str(args.query)),
  },
};
