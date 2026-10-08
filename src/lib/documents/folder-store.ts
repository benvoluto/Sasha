// Document folders: one level of folders for a team's documents, shown in the
// documents panel. A document's folder is `document.doc_folder_id`; this
// module owns the `document_folder` table (its DDL is in DOCUMENT_SCHEMA in
// store.ts so the documents schema applies as one). These are not the Phase 2
// source folders (src/lib/sources/store.ts).
//
// A folder's updated_at is the date the panel shows: it bumps on rename and
// when documents move in or out (store.ts touchDocFolders).
//
// Without POSTGRES_URL (local development, tests) folders live in process
// memory (store.ts docFolderMemory), cleared by resetMemoryStore().

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import type { DocumentFolder } from "./folders-contract";
import { docFolderMemory, DOCUMENT_SCHEMA, isUuid, memoryDocuments, nowIso, type DocFolderRow } from "./store";

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("documents", DOCUMENT_SCHEMA);
const iso = (v: unknown) => new Date(v as string).toISOString();

export type CreateDocFolderResult = { ok: true; folder: DocumentFolder } | { ok: false; reason: "duplicate" };
export type RenameDocFolderResult = { ok: true; folder: DocumentFolder } | { ok: false; reason: "not_found" | "duplicate" };

function rowToFolder(r: Record<string, unknown>): DocumentFolder {
  return {
    id: String(r.id),
    name: String(r.name),
    document_count: Number(r.document_count ?? 0),
    created_by: String(r.created_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

// --- In-memory helpers ---------------------------------------------------------

function memoryFolder(f: DocFolderRow): DocumentFolder {
  const document_count = [...memoryDocuments().values()].filter((d) => d.team_id === f.team_id && d.doc_folder_id === f.id && !d.archived).length;
  return { id: f.id, name: f.name, document_count, created_by: f.created_by, created_at: f.created_at, updated_at: f.updated_at };
}

/** Names clash ignoring case, as the SQL unique index on lower(name) does. */
function memoryNameTaken(teamId: string, name: string, exceptId?: string): boolean {
  const key = name.toLowerCase();
  return [...docFolderMemory.values()].some((f) => f.team_id === teamId && f.id !== exceptId && f.name.toLowerCase() === key);
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23505";

// --- Queries -------------------------------------------------------------------

/** The team's folders, by name ignoring case, each with its count of non-archived documents. */
export async function listDocFolders(teamId: string): Promise<DocumentFolder[]> {
  if (!hasDb()) {
    return [...docFolderMemory.values()]
      .filter((f) => f.team_id === teamId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id))
      .map(memoryFolder);
  }
  await schema();
  const { rows } = await sql`
    SELECT f.id, f.name, f.created_by, f.created_at, f.updated_at,
           COUNT(d.id) FILTER (WHERE NOT d.archived) AS document_count
      FROM document_folder f
      LEFT JOIN document d ON d.doc_folder_id = f.id AND d.team_id = f.team_id
     WHERE f.team_id = ${teamId}
     GROUP BY f.id
     ORDER BY lower(f.name), f.id`;
  return rows.map(rowToFolder);
}

/** One folder of the team, or null (unknown id, or another team's folder). */
export async function getDocFolder(teamId: string, id: string): Promise<DocumentFolder | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    const f = docFolderMemory.get(id.toLowerCase());
    return f && f.team_id === teamId ? memoryFolder(f) : null;
  }
  await schema();
  const { rows } = await sql`
    SELECT f.id, f.name, f.created_by, f.created_at, f.updated_at,
           COUNT(d.id) FILTER (WHERE NOT d.archived) AS document_count
      FROM document_folder f
      LEFT JOIN document d ON d.doc_folder_id = f.id AND d.team_id = f.team_id
     WHERE f.id = ${id} AND f.team_id = ${teamId}
     GROUP BY f.id`;
  return rows[0] ? rowToFolder(rows[0]) : null;
}

/** Create a folder. A name the team already uses (ignoring case) is refused as a duplicate. */
export async function createDocFolder(teamId: string, agent: string, name: string): Promise<CreateDocFolderResult> {
  const clean = name.trim();
  if (!hasDb()) {
    if (memoryNameTaken(teamId, clean)) return { ok: false, reason: "duplicate" };
    const now = nowIso();
    const row: DocFolderRow = { id: randomUUID(), team_id: teamId, name: clean, created_by: agent, created_at: now, updated_at: now };
    docFolderMemory.set(row.id, row);
    return { ok: true, folder: memoryFolder(row) };
  }
  await schema();
  // ON CONFLICT DO NOTHING covers the unique index on (team_id, lower(name)),
  // including a concurrent create of the same name.
  const { rows } = await sql`
    INSERT INTO document_folder (id, team_id, name, created_by)
    VALUES (${randomUUID()}, ${teamId}, ${clean}, ${agent})
    ON CONFLICT DO NOTHING
    RETURNING id, name, created_by, created_at, updated_at, 0 AS document_count`;
  return rows[0] ? { ok: true, folder: rowToFolder(rows[0]) } : { ok: false, reason: "duplicate" };
}

/** Rename a folder (bumps its updated_at). */
export async function renameDocFolder(teamId: string, id: string, name: string): Promise<RenameDocFolderResult> {
  const clean = name.trim();
  if (!isUuid(id)) return { ok: false, reason: "not_found" };
  if (!hasDb()) {
    const f = docFolderMemory.get(id.toLowerCase());
    if (!f || f.team_id !== teamId) return { ok: false, reason: "not_found" };
    if (memoryNameTaken(teamId, clean, f.id)) return { ok: false, reason: "duplicate" };
    f.name = clean;
    f.updated_at = nowIso();
    return { ok: true, folder: memoryFolder(f) };
  }
  await schema();
  try {
    const { rowCount } = await sql`
      UPDATE document_folder SET name = ${clean}, updated_at = now()
       WHERE id = ${id} AND team_id = ${teamId}`;
    if (!rowCount) return { ok: false, reason: "not_found" };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
  const folder = await getDocFolder(teamId, id);
  return folder ? { ok: true, folder } : { ok: false, reason: "not_found" };
}

/**
 * Delete a folder. Its documents, archived ones too, move to the top level;
 * returns how many moved, or null when the team has no such folder. The
 * foreign key's ON DELETE SET NULL is only a backstop for a document filed
 * between the two statements.
 */
export async function deleteDocFolder(teamId: string, id: string): Promise<{ moved: number } | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    const key = id.toLowerCase();
    const f = docFolderMemory.get(key);
    if (!f || f.team_id !== teamId) return null;
    let moved = 0;
    const docs = memoryDocuments();
    for (const d of [...docs.values()]) {
      if (d.team_id === teamId && d.doc_folder_id === key) {
        docs.set(d.id, { ...d, doc_folder_id: null });
        moved++;
      }
    }
    docFolderMemory.delete(key);
    return { moved };
  }
  await schema();
  const exists = await sql`SELECT 1 FROM document_folder WHERE id = ${id} AND team_id = ${teamId}`;
  if (!exists.rows[0]) return null;
  // Clearing the documents first keeps the count (a delete first would let the
  // foreign key null them silently). updated_at stays: a move isn't an edit.
  const cleared = await sql`UPDATE document SET doc_folder_id = NULL WHERE team_id = ${teamId} AND doc_folder_id = ${id}`;
  const deleted = await sql`DELETE FROM document_folder WHERE id = ${id} AND team_id = ${teamId}`;
  if (!deleted.rowCount) return null;
  return { moved: cleared.rowCount ?? 0 };
}
