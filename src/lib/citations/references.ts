// The document's sources cited, resolved against the stores: each numbered
// reference (collectCitations) with its source title, page and passage text,
// and whether it still holds (the source linked to the document, the passage
// or table still there). The export routes print these as footnotes and a
// References list; the citations route returns them for the editor's lint.
//
// Server-only. Team-scoped: every lookup goes through the caller's team, so a
// mark copied from another team's document resolves as "deleted".
//
// CONTRACT (Phase 7): phase7-spec.md §2.6. Owned by the citations track; the
// export track calls resolveReferences.

import { getTable } from "@/lib/data/store";
import type { PMNode } from "@/lib/documents/sections";
import { passagePrefix } from "@/lib/sources/pages";
import { getSource, listDocumentSources, listPassages, type StoredPassage } from "@/lib/sources/store";
import { collectCitations, MAX_CITATION_EXCERPT, type CitationsResponse, type CitedReference, type ResolvedReference } from "./contract";
import { quoteKey, quoteMatches } from "./quote";

const excerpt = (s: string) => (s.length > MAX_CITATION_EXCERPT ? `${s.slice(0, MAX_CITATION_EXCERPT - 1).trimEnd()}…` : s);

/** The passage's index from its id ("S1a2b3c4d.P7" → 7), or null. */
export const passageIndex = (passageId: string): number | null => {
  const m = /\.P(\d+)$/.exec(passageId);
  return m ? Number(m[1]) : null;
};

/**
 * A resolved reference with the uploaded file's name (null for a URL source or
 * when gone), so the exports can cite an upload by title, file name and page
 * rather than link into the app (Phase 8).
 */
export type ResolvedReferenceWithFile = ResolvedReference & { fileName: string | null };

export async function resolveReferences(teamId: string, documentId: string, refs: CitedReference[]): Promise<ResolvedReferenceWithFile[]> {
  const linked = (await listDocumentSources(teamId, documentId)) ?? [];
  const linkedIds = new Set(linked.map((s) => s.id));
  const byPrefix = new Map(linked.map((s) => [passagePrefix(s.id), s.id]));
  const passageCache = new Map<string, StoredPassage[]>();
  const passagesOf = async (sourceId: string) => {
    if (!passageCache.has(sourceId)) passageCache.set(sourceId, (await listPassages(teamId, sourceId)) ?? []);
    return passageCache.get(sourceId)!;
  };

  const out: ResolvedReferenceWithFile[] = [];
  for (const ref of refs) {
    // The mark's quote is stored content anyone on the team can edit or paste, so
    // it is kept only once checked against the passage it resolves to (below);
    // otherwise the exports would print it as the source's words.
    const base: ResolvedReferenceWithFile = { ...ref, quote: null, status: "deleted", sourceTitle: "Deleted source", sourceUrl: null, page: null, excerpt: null, tableName: null, fileName: null };
    if (ref.kind === "table") {
      const table = ref.dataTableId ? await getTable(teamId, ref.dataTableId) : null;
      if (!table) {
        out.push(base);
        continue;
      }
      const sourceTitle = table.source.title || table.source.filename || "Untitled source";
      const fileName = table.source.filename || null;
      out.push({ ...base, sourceId: table.source_id, sourceTitle, fileName, page: table.page, tableName: table.name || "Table", status: linkedIds.has(table.source_id) ? "ok" : "unlinked" });
      continue;
    }
    const passageId = ref.passageId ?? "";
    const sourceId = ref.sourceId ?? byPrefix.get(passageId.split(".")[0]) ?? null;
    const source = sourceId ? await getSource(teamId, sourceId) : null;
    if (!source) {
      out.push(base);
      continue;
    }
    const sourceTitle = source.title || source.filename || source.url || "Untitled source";
    const idx = passageIndex(passageId);
    const passage = (await passagesOf(source.id)).find((p) => p.id === passageId || (idx !== null && p.idx === idx && passageId.startsWith(passagePrefix(source.id))));
    out.push({
      ...base,
      sourceId: source.id,
      sourceTitle,
      sourceUrl: source.kind === "url" ? source.url : null,
      fileName: source.kind === "url" ? null : source.filename || null,
      page: passage?.page ?? null,
      excerpt: passage ? excerpt(passage.text) : null,
      quote: passage && quoteKey(ref.quote) && quoteMatches(ref.quote!, passage.text) ? ref.quote : null,
      status: !passage ? "missing" : linkedIds.has(source.id) ? "ok" : "unlinked",
    });
  }
  return out;
}

/** The stored document's references, resolved, with the problems (the citations route's body). */
export async function documentCitations(teamId: string, documentId: string, content: PMNode | null): Promise<CitationsResponse> {
  const { references } = collectCitations(content);
  const resolved = await resolveReferences(teamId, documentId, references);
  return {
    references: resolved,
    problems: resolved.filter((r) => r.status !== "ok").map((r) => ({ key: r.key, number: r.number, status: r.status, sourceTitle: r.sourceTitle })),
  };
}
