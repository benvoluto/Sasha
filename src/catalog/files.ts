// The catalog types that ship with the app: src/catalog/types/*.json, validated
// and bundled by `npm run catalog:build` into catalog.bundle.json. Client-safe
// (no database); team overrides and team-made types are merged on the server by
// src/catalog/index.ts.
//
// CONTRACT (Phase 3): the exported names and signatures below are shared by
// every track. The catalog-pipeline track owns the implementation.

import bundle from "./catalog.bundle.json";
import { DocumentTypeDefinition, sortedSections } from "./schema";

/**
 * Keys stored before the catalog existed (Phase 1 type picker, legacy report
 * templates) mapped to their catalog keys. A definition's own `aliases` are
 * honoured as well; this map is the fallback for files that omit them.
 */
export const LEGACY_TYPE_ALIASES: Record<string, string> = {
  fie_basic: "fie",
  general_report: "general-report",
  memo: "policy-decision-memo",
};

let cache: DocumentTypeDefinition[] | null = null;

/** Every bundled definition, sorted by title. Re-validated once per process; an invalid entry is skipped with a console error. */
export function fileTypes(): DocumentTypeDefinition[] {
  if (cache) return cache;
  const out: DocumentTypeDefinition[] = [];
  for (const raw of bundle as unknown[]) {
    const r = DocumentTypeDefinition.safeParse(raw);
    if (r.success) out.push({ ...r.data, sections: sortedSections(r.data.sections) });
    else console.error("[catalog] invalid bundled type skipped", (raw as { key?: unknown })?.key, r.error.issues[0]);
  }
  cache = out.sort((a, b) => a.title.localeCompare(b.title));
  return cache;
}

/** The canonical key for a stored key: itself, or the catalog key it is an alias of. */
export function resolveFileTypeKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const types = fileTypes();
  if (types.some((t) => t.key === key)) return key;
  const viaAlias = types.find((t) => t.aliases.includes(key));
  if (viaAlias) return viaAlias.key;
  const legacy = LEGACY_TYPE_ALIASES[key];
  return legacy && types.some((t) => t.key === legacy) ? legacy : key;
}

/** A bundled definition by key or alias. */
export function fileTypeByKey(key: string | null | undefined): DocumentTypeDefinition | null {
  const k = resolveFileTypeKey(key);
  return k ? (fileTypes().find((t) => t.key === k) ?? null) : null;
}
