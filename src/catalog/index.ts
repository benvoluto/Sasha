// The effective catalog for a team: bundled file types merged with the team's
// document_type rows (overrides of file types, team-made types, enabled flags).
// Server-only: imports the database store. Client code uses
// GET /api/document-types and the client-safe ./schema and ./files.
//
// Merge rules (phase3-spec §1.1):
//   - file type, no row            → the file definition, enabled, not overridden.
//   - file type + row + definition → the row's definition (key forced to the
//                                    file key), overridden, `enabled` from the row.
//   - file type + row, no definition → the file definition, `enabled` from the row.
//   - team row                     → a team type.
// A stored definition that no longer validates is skipped with a console error
// (an override falls back to the file definition, still marked overridden so
// the admin page can revert it); it never breaks the list.
//
// CONTRACT (Phase 3): listTypes, getType and listTypeSummaries are shared by
// every track; their signatures do not change.

import type { CatalogEntry, DocumentTypeDefinition, DocumentTypeSummary } from "./schema";
import { FAMILIES, parseDefinition, sortedSections, toTypeSummary } from "./schema";
import { fileTypes, LEGACY_TYPE_ALIASES } from "./files";
import { outlineTypeDefinition, typeKeyFromTitle, uniqueKey } from "./from-outline";
import {
  clearTypeDefinition,
  deleteTypeRow,
  insertTypeRow,
  listTypeRows,
  upsertTypeDefinition,
  upsertTypeEnabled,
  type DocumentTypeRow,
} from "./store";
import { listSections, type PMNode } from "@/lib/documents/sections";

export { rubricFor, UNIVERSAL_RUBRIC } from "./universal-rubric";
export { fileTypeByKey, fileTypes, resolveFileTypeKey } from "./files";

type Catalog = { entries: CatalogEntry[]; rows: Map<string, DocumentTypeRow> };

function storedDefinition(row: DocumentTypeRow, key: string): DocumentTypeDefinition | null {
  if (!row.definition || typeof row.definition !== "object") return null;
  const r = parseDefinition({ ...(row.definition as Record<string, unknown>), key });
  if (r.ok) return { ...r.definition, sections: sortedSections(r.definition.sections) };
  console.error("[catalog] invalid stored type skipped", row.team_id, key, r.errors[0]);
  return null;
}

const familyRank = (f: string) => {
  const i = (FAMILIES as readonly string[]).indexOf(f);
  return i < 0 ? FAMILIES.length : i;
};

function byFamilyThenTitle(a: CatalogEntry, b: CatalogEntry): number {
  return familyRank(a.definition.family) - familyRank(b.definition.family) || a.definition.title.localeCompare(b.definition.title);
}

async function loadCatalog(teamId: string): Promise<Catalog> {
  const rows = new Map((await listTypeRows(teamId)).map((r) => [r.key, r]));
  const files = fileTypes();
  const fileKeys = new Set(files.map((f) => f.key));
  const entries: CatalogEntry[] = files.map((file) => {
    const row = rows.get(file.key);
    if (!row) return { definition: file, origin: "file", enabled: true, overridden: false, updated_at: null };
    const own = row.definition != null ? storedDefinition(row, file.key) : null;
    return { definition: own ?? file, origin: "file", enabled: row.enabled, overridden: row.definition != null, updated_at: row.updated_at };
  });
  for (const row of rows.values()) {
    if (fileKeys.has(row.key)) continue;
    // A team type, or an override whose file left the catalog: keep it usable as a team type.
    const def = storedDefinition(row, row.key);
    if (def) entries.push({ definition: def, origin: "team", enabled: row.enabled, overridden: false, updated_at: row.updated_at });
  }
  return { entries: entries.sort(byFamilyThenTitle), rows };
}

function findEntry(entries: CatalogEntry[], key: string | null | undefined): CatalogEntry | null {
  if (!key) return null;
  const exact = entries.find((e) => e.definition.key === key);
  if (exact) return exact;
  const file = new Map(fileTypes().map((f) => [f.key, f]));
  const viaAlias = entries.find((e) => e.definition.aliases.includes(key) || (e.origin === "file" && file.get(e.definition.key)?.aliases.includes(key)));
  if (viaAlias) return viaAlias;
  const legacy = LEGACY_TYPE_ALIASES[key];
  return legacy ? (entries.find((e) => e.definition.key === legacy) ?? null) : null;
}

/** Every key and alias in use for the team (file keys and aliases, legacy aliases, team keys and aliases, every row key), optionally ignoring one type. */
function takenKeys(cat: Catalog, except?: string): Set<string> {
  const taken = new Set<string>(Object.keys(LEGACY_TYPE_ALIASES));
  for (const f of fileTypes()) {
    if (f.key === except) continue;
    taken.add(f.key);
    f.aliases.forEach((a) => taken.add(a));
  }
  for (const e of cat.entries) {
    if (e.definition.key === except) continue;
    taken.add(e.definition.key);
    e.definition.aliases.forEach((a) => taken.add(a));
  }
  for (const k of cat.rows.keys()) if (k !== except) taken.add(k);
  if (except) {
    // A type may keep the legacy alias that points at it.
    for (const [alias, target] of Object.entries(LEGACY_TYPE_ALIASES)) if (target === except) taken.delete(alias);
  }
  return taken;
}

/** Every type the team can see, sorted by family then title. Disabled types are left out unless `includeDisabled` (the admin page). */
export async function listTypes(teamId: string, opts: { includeDisabled?: boolean } = {}): Promise<CatalogEntry[]> {
  const { entries } = await loadCatalog(teamId);
  return opts.includeDisabled ? entries : entries.filter((e) => e.enabled);
}

/**
 * One type by key or alias, as the team sees it. Disabled types ARE returned
 * (a document typed before the type was disabled keeps drafting); callers that
 * offer types for choosing filter on `enabled`.
 */
export async function getType(teamId: string, key: string | null | undefined): Promise<CatalogEntry | null> {
  if (!key) return null;
  return findEntry((await loadCatalog(teamId)).entries, key);
}

/** Client-safe summaries for the type picker / gallery. */
export async function listTypeSummaries(teamId: string, opts: { includeDisabled?: boolean } = {}): Promise<DocumentTypeSummary[]> {
  return (await listTypes(teamId, opts)).map(toTypeSummary);
}

// --- Admin writes (the /api/document-types routes) -----------------------------

export type CatalogWriteResult = { ok: true; entry: CatalogEntry } | { ok: false; reason: "not_found" | "key_mismatch" | "clash"; message: string };

function clashMessage(def: DocumentTypeDefinition, taken: Set<string>): string | null {
  if (taken.has(def.key)) return `A document type with the key "${def.key}" already exists.`;
  const alias = def.aliases.find((a) => taken.has(a));
  return alias ? `The alias "${alias}" is already used by another document type.` : null;
}

async function entryFor(teamId: string, key: string): Promise<CatalogEntry> {
  const entry = findEntry((await loadCatalog(teamId)).entries, key);
  if (!entry) throw new Error(`[catalog] type ${key} vanished after a write`);
  return entry;
}

/** Create a team-made type. Its key (and aliases) must not equal any catalog key or alias, or another team type's. */
export async function createTeamType(teamId: string, agent: string, definition: DocumentTypeDefinition): Promise<CatalogWriteResult> {
  const cat = await loadCatalog(teamId);
  const clash = clashMessage(definition, takenKeys(cat));
  if (clash) return { ok: false, reason: "clash", message: clash };
  const row = await insertTypeRow(teamId, agent, "team", definition);
  if (!row) return { ok: false, reason: "clash", message: `A document type with the key "${definition.key}" already exists.` };
  return { ok: true, entry: await entryFor(teamId, definition.key) };
}

/**
 * Replace the team's definition of a type: a file type gets (or updates) its
 * override row, a team type its row. The stored version is
 * max(previous stored version, file version) + 1, whatever the body says.
 */
export async function saveTypeDefinition(teamId: string, agent: string, key: string, definition: DocumentTypeDefinition): Promise<CatalogWriteResult> {
  if (definition.key !== key) return { ok: false, reason: "key_mismatch", message: "The definition's key must match the type being edited." };
  const cat = await loadCatalog(teamId);
  const entry = cat.entries.find((e) => e.definition.key === key);
  if (!entry) return { ok: false, reason: "not_found", message: "Document type not found." };
  const alias = definition.aliases.find((a) => takenKeys(cat, key).has(a));
  if (alias) return { ok: false, reason: "clash", message: `The alias "${alias}" is already used by another document type.` };
  const file = fileTypes().find((f) => f.key === key);
  const row = cat.rows.get(key);
  const previous = row?.definition != null ? row.version : 0;
  const version = Math.max(previous, file?.version ?? 0, entry.origin === "team" ? entry.definition.version : 0) + 1;
  await upsertTypeDefinition(teamId, agent, file ? "override" : "team", { ...definition, version });
  return { ok: true, entry: await entryFor(teamId, key) };
}

/** Enable or disable a type (by key or alias). A file type with no row gets an enable-only row. */
export async function setTypeEnabled(teamId: string, agent: string, key: string, enabled: boolean): Promise<CatalogEntry | null> {
  const entry = findEntry((await loadCatalog(teamId)).entries, key);
  if (!entry) return null;
  await upsertTypeEnabled(teamId, agent, entry.definition.key, entry.origin === "file" ? "override" : "team", enabled);
  return entryFor(teamId, entry.definition.key);
}

/**
 * DELETE: a team type's row is deleted; a file type's edits are reverted
 * ("Revert to catalog"). A disabled file type keeps an enable-only row so
 * reverting its text does not silently re-enable it. Returns what happened, or
 * null when there was nothing to delete.
 */
export async function removeTypeEdits(teamId: string, agent: string, key: string): Promise<"deleted" | "reverted" | null> {
  const cat = await loadCatalog(teamId);
  const entry = findEntry(cat.entries, key);
  const canonical = entry?.definition.key ?? key;
  const row = cat.rows.get(canonical);
  if (!row) return null;
  if (fileTypes().some((f) => f.key === canonical)) {
    if (row.definition == null) return null;
    if (row.enabled) await deleteTypeRow(teamId, canonical);
    else await clearTypeDefinition(teamId, agent, canonical);
    return "reverted";
  }
  return (await deleteTypeRow(teamId, canonical)) ? "deleted" : null;
}

export type SaveOutlineInput = {
  document: { title: string; type_key: string | null; content_json: PMNode };
  title: string;
  key?: string;
  family?: DocumentTypeDefinition["family"];
  summary?: string;
};

export type SaveOutlineResult =
  | { ok: true; entry: CatalogEntry; specKeys: Record<string, string> }
  | { ok: false; reason: "no_headings" | "invalid" | "clash"; message: string; issues?: string[] };

/** "Save outline as type": a team type from the document's top-level headings (see ./from-outline.ts). */
export async function saveOutlineAsType(teamId: string, agent: string, input: SaveOutlineInput): Promise<SaveOutlineResult> {
  const cat = await loadCatalog(teamId);
  const source = findEntry(cat.entries, input.document.type_key)?.definition ?? null;
  const key = uniqueKey(input.key ?? typeKeyFromTitle(input.title), takenKeys(cat));
  const built = outlineTypeDefinition({
    key,
    title: input.title,
    family: input.family,
    summary: input.summary,
    documentTitle: input.document.title,
    sections: listSections(input.document.content_json),
    source,
    today: new Date().toISOString().slice(0, 10),
  });
  if (!built) return { ok: false, reason: "no_headings", message: "This document has no headings to save as a type." };
  const parsed = parseDefinition(built.definition);
  if (!parsed.ok) return { ok: false, reason: "invalid", message: parsed.errors[0] ?? "The outline could not be saved as a type.", issues: parsed.errors };
  const created = await createTeamType(teamId, agent, parsed.definition);
  if (!created.ok) return { ok: false, reason: "clash", message: created.message };
  return { ok: true, entry: created.entry, specKeys: built.specKeys };
}
