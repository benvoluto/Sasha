// DEPRECATED compatibility shim (Phase 3). Document types now come from the
// zod-validated catalog: client code reads GET /api/document-types (team view,
// with overrides and team types) and server code uses getType/listTypes from
// @/catalog. This module keeps the Phase 1 shape over the bundled file types
// only, for callers not yet migrated; delete it once nothing imports it.

import { fileTypeByKey, fileTypes } from "@/catalog/files";
import type { DocumentTypeDefinition } from "@/catalog/schema";

export type DocumentTypeOption = {
  key: string;
  title: string;
  sections: Array<{ key: string; heading: string; level?: number }>;
};

function toOption(t: DocumentTypeDefinition): DocumentTypeOption {
  return { key: t.key, title: t.title, sections: t.sections.map((s) => ({ key: s.key, heading: s.heading, level: s.level })) };
}

/** @deprecated Use GET /api/document-types (client) or listTypes (server). */
export const DOCUMENT_TYPES: DocumentTypeOption[] = fileTypes().map(toOption);

/** @deprecated Use getType (server). Accepts catalog keys and their aliases. */
export function documentTypeByKey(key: string | null | undefined): DocumentTypeOption | null {
  const t = fileTypeByKey(key);
  return t ? toOption(t) : null;
}
