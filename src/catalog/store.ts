// The team's document_type rows: edits ("overrides") of catalog file types,
// team-made types, and enable/disable flags. One row per (team, key). A row
// with a NULL definition only toggles `enabled` on a file type. The merge with
// the bundled file types lives in ./index.ts; this module is storage only.
//
// Definitions are validated with parseDefinition before every write (a bad
// definition throws) and again when read (src/catalog/index.ts skips an invalid
// stored row with a console error).
//
// Without POSTGRES_URL (local development, tests) rows live in process memory.

import { sql } from "@vercel/postgres";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { parseDefinition, type DocumentTypeDefinition } from "./schema";
import { processMemory } from "@/lib/process-memory";

export const CATALOG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS document_type (
     team_id TEXT NOT NULL,
     key TEXT NOT NULL,
     origin TEXT NOT NULL,
     version INT NOT NULL DEFAULT 1,
     title TEXT NOT NULL DEFAULT '',
     family TEXT NOT NULL DEFAULT 'general',
     summary TEXT NOT NULL DEFAULT '',
     definition JSONB,
     provenance JSONB,
     enabled BOOLEAN NOT NULL DEFAULT true,
     created_by TEXT NOT NULL,
     updated_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (team_id, key))`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("catalog", CATALOG_SCHEMA);

/** 'override' edits (or only toggles) a catalog file type; 'team' is a team-made type. */
export type RowOrigin = "override" | "team";

export type DocumentTypeRow = {
  team_id: string;
  key: string;
  origin: RowOrigin;
  version: number;
  title: string;
  family: string;
  summary: string;
  /** Unvalidated stored JSON; null = the row only sets `enabled`. */
  definition: unknown | null;
  provenance: unknown | null;
  enabled: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

const iso = (v: unknown) => new Date(v as string).toISOString();

function rowToRecord(r: Record<string, unknown>): DocumentTypeRow {
  return {
    team_id: String(r.team_id),
    key: String(r.key),
    origin: r.origin === "team" ? "team" : "override",
    version: Number(r.version ?? 1),
    title: String(r.title ?? ""),
    family: String(r.family ?? "general"),
    summary: String(r.summary ?? ""),
    definition: r.definition ?? null,
    provenance: r.provenance ?? null,
    enabled: r.enabled !== false,
    created_by: String(r.created_by),
    updated_by: String(r.updated_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** Throws when the definition is invalid: callers validate first and report issues; this is the last guard. */
function validated(definition: DocumentTypeDefinition): DocumentTypeDefinition {
  const r = parseDefinition(definition);
  if (!r.ok) throw new Error(`Invalid document type definition: ${r.errors.join("; ")}`);
  return r.definition;
}

// --- In-memory fallback -------------------------------------------------------

const memory = processMemory("catalog", () => new Map<string, DocumentTypeRow>());
const memKey = (teamId: string, key: string) => `${teamId}\u0000${key}`;

/** Clears the in-memory store (tests). */
export function resetCatalogStore() {
  memory.clear();
}

let lastStamp = 0;
function nowIso(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

const clone = <T>(v: T): T => (v == null ? v : structuredClone(v));

// --- Queries -------------------------------------------------------------------

export async function listTypeRows(teamId: string): Promise<DocumentTypeRow[]> {
  if (!hasDb()) {
    return [...memory.values()].filter((r) => r.team_id === teamId).map((r) => ({ ...r, definition: clone(r.definition) }));
  }
  await schema();
  const { rows } = await sql`SELECT * FROM document_type WHERE team_id = ${teamId} ORDER BY key`;
  return rows.map(rowToRecord);
}

export async function getTypeRow(teamId: string, key: string): Promise<DocumentTypeRow | null> {
  if (!hasDb()) {
    const r = memory.get(memKey(teamId, key));
    return r ? { ...r, definition: clone(r.definition) } : null;
  }
  await schema();
  const { rows } = await sql`SELECT * FROM document_type WHERE team_id = ${teamId} AND key = ${key}`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Insert a team-made type. Returns null when the team already has a row with that key. */
export async function insertTypeRow(teamId: string, agent: string, origin: RowOrigin, definition: DocumentTypeDefinition): Promise<DocumentTypeRow | null> {
  const def = validated(definition);
  if (!hasDb()) {
    const k = memKey(teamId, def.key);
    if (memory.has(k)) return null;
    const now = nowIso();
    const row: DocumentTypeRow = {
      team_id: teamId,
      key: def.key,
      origin,
      version: def.version,
      title: def.title,
      family: def.family,
      summary: def.summary,
      definition: clone(def),
      provenance: clone(def.provenance),
      enabled: true,
      created_by: agent,
      updated_by: agent,
      created_at: now,
      updated_at: now,
    };
    memory.set(k, row);
    return { ...row, definition: clone(row.definition) };
  }
  await schema();
  const { rows } = await sql`
    INSERT INTO document_type (team_id, key, origin, version, title, family, summary, definition, provenance, created_by, updated_by)
    VALUES (${teamId}, ${def.key}, ${origin}, ${def.version}, ${def.title}, ${def.family}, ${def.summary},
            ${JSON.stringify(def)}::jsonb, ${JSON.stringify(def.provenance)}::jsonb, ${agent}, ${agent})
    ON CONFLICT (team_id, key) DO NOTHING
    RETURNING *`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Create or replace the row's definition (an override of a file type, or a
 * team type's new version). Keeps `enabled` and `created_*` of an existing row.
 */
export async function upsertTypeDefinition(teamId: string, agent: string, origin: RowOrigin, definition: DocumentTypeDefinition): Promise<DocumentTypeRow> {
  const def = validated(definition);
  if (!hasDb()) {
    const k = memKey(teamId, def.key);
    const prev = memory.get(k);
    const now = nowIso();
    const row: DocumentTypeRow = {
      team_id: teamId,
      key: def.key,
      origin,
      version: def.version,
      title: def.title,
      family: def.family,
      summary: def.summary,
      definition: clone(def),
      provenance: clone(def.provenance),
      enabled: prev?.enabled ?? true,
      created_by: prev?.created_by ?? agent,
      updated_by: agent,
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    memory.set(k, row);
    return { ...row, definition: clone(row.definition) };
  }
  await schema();
  const json = JSON.stringify(def);
  const prov = JSON.stringify(def.provenance);
  const { rows } = await sql`
    INSERT INTO document_type (team_id, key, origin, version, title, family, summary, definition, provenance, created_by, updated_by)
    VALUES (${teamId}, ${def.key}, ${origin}, ${def.version}, ${def.title}, ${def.family}, ${def.summary},
            ${json}::jsonb, ${prov}::jsonb, ${agent}, ${agent})
    ON CONFLICT (team_id, key) DO UPDATE SET
      origin = EXCLUDED.origin, version = EXCLUDED.version, title = EXCLUDED.title, family = EXCLUDED.family,
      summary = EXCLUDED.summary, definition = EXCLUDED.definition, provenance = EXCLUDED.provenance,
      updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING *`;
  return rowToRecord(rows[0]);
}

/** Set `enabled`; a file type with no row gets one with a NULL definition. */
export async function upsertTypeEnabled(teamId: string, agent: string, key: string, origin: RowOrigin, enabled: boolean): Promise<DocumentTypeRow> {
  if (!hasDb()) {
    const k = memKey(teamId, key);
    const prev = memory.get(k);
    const now = nowIso();
    const row: DocumentTypeRow = prev
      ? { ...prev, enabled, updated_by: agent, updated_at: now }
      : {
          team_id: teamId,
          key,
          origin,
          version: 1,
          title: "",
          family: "general",
          summary: "",
          definition: null,
          provenance: null,
          enabled,
          created_by: agent,
          updated_by: agent,
          created_at: now,
          updated_at: now,
        };
    memory.set(k, row);
    return { ...row, definition: clone(row.definition) };
  }
  await schema();
  const { rows } = await sql`
    INSERT INTO document_type (team_id, key, origin, enabled, created_by, updated_by)
    VALUES (${teamId}, ${key}, ${origin}, ${enabled}, ${agent}, ${agent})
    ON CONFLICT (team_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING *`;
  return rowToRecord(rows[0]);
}

/** Drop an override's definition but keep the row (and so its `enabled` flag). */
export async function clearTypeDefinition(teamId: string, agent: string, key: string): Promise<DocumentTypeRow | null> {
  if (!hasDb()) {
    const k = memKey(teamId, key);
    const prev = memory.get(k);
    if (!prev) return null;
    const row: DocumentTypeRow = { ...prev, definition: null, provenance: null, version: 1, title: "", family: "general", summary: "", updated_by: agent, updated_at: nowIso() };
    memory.set(k, row);
    return { ...row };
  }
  await schema();
  const { rows } = await sql`
    UPDATE document_type
       SET definition = NULL, provenance = NULL, version = 1, title = '', family = 'general', summary = '',
           updated_by = ${agent}, updated_at = now()
     WHERE team_id = ${teamId} AND key = ${key}
    RETURNING *`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function deleteTypeRow(teamId: string, key: string): Promise<boolean> {
  if (!hasDb()) return memory.delete(memKey(teamId, key));
  await schema();
  const { rows } = await sql`DELETE FROM document_type WHERE team_id = ${teamId} AND key = ${key} RETURNING key`;
  return rows.length > 0;
}
