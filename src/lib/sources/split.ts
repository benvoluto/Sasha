// Upload-group metadata and the extraction splitter. Extracted text is organized
// as "=== Document: <name> ===" sections; splitDocuments turns it back into one
// entry per source document (or a single entry when no markers are present).

import { normalizeForMatching } from "@/lib/text-match";
import type { SourceDocument } from "./passages";

export type GroupMetadata = {
  id?: string;
  files?: Array<{ name?: string; type?: string; url?: string }>;
  geminiProcessing?: { status?: string; extractedContent?: string };
};

const DOC_MARKER = /^===\s*Document:\s*(.+?)\s*===$/gm;

// Documents are split on the extraction's line-anchored markers FIRST, then each
// document's text is normalized (typography folded, whitespace collapsed) — the
// split needs the original newlines, the matcher needs them gone. Normalizing
// here means match offsets and excerpts refer to the same canonical string.
export function splitDocuments(groupId: string, extracted: string): SourceDocument[] {
  const markers = [...extracted.matchAll(DOC_MARKER)];
  if (markers.length === 0) {
    return [{ doc_id: `${groupId}-0`, doc_type: "source", text: normalizeForMatching(extracted) }];
  }
  const docs: SourceDocument[] = [];
  for (let i = 0; i < markers.length; i++) {
    const name = (markers[i][1] || `document ${i + 1}`).trim();
    const start = (markers[i].index ?? 0) + markers[i][0].length;
    const end = i + 1 < markers.length ? (markers[i + 1].index ?? extracted.length) : extracted.length;
    docs.push({ doc_id: `${groupId}-${i}`, doc_type: name, text: normalizeForMatching(extracted.slice(start, end)) });
  }
  return docs;
}
