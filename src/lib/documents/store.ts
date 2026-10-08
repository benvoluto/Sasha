// Documents: one row per document, owned by a team (the Clerk organization, or
// a personal team for a user with no organization). The body is one ProseMirror
// JSON tree; `content_text` is its plain text for search and the classifier.
//
// Saves use optimistic concurrency: the client sends the `updated_at` it last
// saw, and a save over a newer version is refused with the current row so the
// editor can show the conflict instead of silently overwriting a teammate.
//
// Without POSTGRES_URL (local development, tests) documents live in process
// memory and do not survive a restart.

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { docText, EMPTY_DOC, type PMNode } from "./sections";
import { processMemory } from "@/lib/process-memory";
import { DOC_FOLDER_ROOT, type BulkDocumentsBody } from "./folders-contract";
import { parseClassifierState, type ClassifierState, type TypeSource } from "@/lib/classifier/contract";

export const DOCUMENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS document (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     type_key TEXT,
     type_confidence REAL,
     type_source TEXT,
     content_json JSONB NOT NULL,
     content_text TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     folder_id UUID,
     archived BOOLEAN NOT NULL DEFAULT false,
     created_by TEXT NOT NULL,
     updated_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_classified_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS document_team_updated_idx ON document (team_id, archived, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS document_section (
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     section_id TEXT NOT NULL,
     spec_key TEXT,
     notes TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'empty',
     last_generated_at TIMESTAMPTZ,
     PRIMARY KEY (document_id, section_id))`,
  `ALTER TABLE document_section ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS document_version (
     id BIGSERIAL PRIMARY KEY,
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     content_json JSONB NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     reason TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS document_version_doc_idx ON document_version (document_id, id DESC)`,
  // Document folders (folder-store.ts): one level, team-owned, names unique per
  // team ignoring case. Not the Phase 2 source folders: `document.folder_id`
  // is that link, `doc_folder_id` is the document's folder in the panel.
  `CREATE TABLE IF NOT EXISTS document_folder (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     name TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS document_folder_team_name_uidx ON document_folder (team_id, lower(name))`,
  `ALTER TABLE document ADD COLUMN IF NOT EXISTS doc_folder_id UUID REFERENCES document_folder(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS document_team_doc_folder_idx ON document (team_id, doc_folder_id, archived, updated_at DESC)`,
  // Phase 4 classifier memory (src/lib/classifier/contract.ts ClassifierState):
  // the last result, dismissal counts per type, the word count at the last run.
  // Written without bumping updated_at (src/lib/classifier/store.ts).
  `ALTER TABLE document ADD COLUMN IF NOT EXISTS classifier_state JSONB`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("documents", DOCUMENT_SCHEMA);

export type DocumentRecord = {
  id: string;
  team_id: string;
  title: string;
  type_key: string | null;
  /** Who set type_key: 'user' (picker, gallery), 'classifier' (applied from the chip), 'restructure'; null when untyped. */
  type_source: TypeSource | null;
  /** The classifier's confidence in its top candidate at the last run (0–1), or null. */
  type_confidence: number | null;
  last_classified_at: string | null;
  /** Classifier memory (last result, dismissals). Never sent in a PATCH; written by src/lib/classifier/store.ts. */
  classifier_state: ClassifierState;
  content_json: PMNode;
  content_text: string;
  notes: string;
  archived: boolean;
  /** The document folder (document_folder), or null at the top level. */
  doc_folder_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type DocumentSummary = Omit<DocumentRecord, "content_json" | "content_text" | "notes" | "classifier_state"> & { excerpt: string };

export type VersionRecord = { id: number; document_id: string; title: string; reason: string; created_by: string; created_at: string };

const iso = (v: unknown) => new Date(v as string).toISOString();

function rowToRecord(r: Record<string, unknown>): DocumentRecord {
  return {
    id: String(r.id),
    team_id: String(r.team_id),
    title: String(r.title ?? ""),
    type_key: (r.type_key as string | null) ?? null,
    type_source: (r.type_source as TypeSource | null) ?? null,
    type_confidence: r.type_confidence == null ? null : Number(r.type_confidence),
    last_classified_at: r.last_classified_at == null ? null : iso(r.last_classified_at),
    classifier_state: parseClassifierState(r.classifier_state),
    content_json: (r.content_json as PMNode) ?? EMPTY_DOC,
    content_text: String(r.content_text ?? ""),
    notes: String(r.notes ?? ""),
    archived: !!r.archived,
    doc_folder_id: r.doc_folder_id == null ? null : String(r.doc_folder_id),
    created_by: String(r.created_by),
    updated_by: String(r.updated_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function summarize(d: DocumentRecord): DocumentSummary {
  const { content_json: _c, content_text, notes: _n, classifier_state: _s, ...rest } = d;
  void _c;
  void _n;
  void _s;
  return { ...rest, excerpt: content_text.slice(0, 200) };
}

// --- In-memory fallback -------------------------------------------------------

const memory = processMemory("documents", () => ({
  docs: new Map<string, DocumentRecord>(),
  versions: [] as Array<VersionRecord & { content_json: PMNode }>,
}));

// Stores keyed by document (section-store.ts) register here so one reset clears
// them too; they import this module, so this module can't import them.
const resetHooks = processMemory("documents.resetHooks", () => new Set<() => void>());

/** Run `fn` whenever resetMemoryStore runs (in-memory stores that hang off documents). */
export function onMemoryStoreReset(fn: () => void) {
  resetHooks.add(fn);
}

/** A document folder row in the in-memory store (folder-store.ts reads and writes these). */
export type DocFolderRow = { id: string; team_id: string; name: string; created_by: string; created_at: string; updated_at: string };

// The in-memory document folders live here rather than in folder-store.ts
// because moves made through this module bump a folder's updated_at, and
// folder-store.ts imports this module (so this one can't import it).
export const docFolderMemory = processMemory("documents.folders", () => new Map<string, DocFolderRow>());

/** The in-memory documents (folder-store.ts counts and re-files them). */
export const memoryDocuments = () => memory.docs;

/** Clears the in-memory store (tests). */
export function resetMemoryStore() {
  memory.docs.clear();
  memory.versions.length = 0;
  for (const fn of resetHooks) fn();
}
onMemoryStoreReset(() => docFolderMemory.clear());

// Timestamps must strictly increase per document so a conflict check on
// `updated_at` can't be fooled by two saves in the same millisecond.
const stamp = processMemory("documents.stamp", () => ({ last: 0 }));
/** A strictly increasing ISO timestamp for in-memory rows (shared with folder-store.ts). */
export function nowIso(): string {
  stamp.last = Math.max(Date.now(), stamp.last + 1);
  return new Date(stamp.last).toISOString();
}

// --- Queries -------------------------------------------------------------------

export type ListDocumentsOptions = {
  archived?: boolean;
  query?: string;
  limit?: number;
  /** "root": documents in no folder; a folder id: that folder's; omitted: every folder. */
  folder?: string;
};

export async function listDocuments(teamId: string, opts: ListDocumentsOptions = {}): Promise<DocumentSummary[]> {
  const archived = !!opts.archived;
  const q = opts.query?.trim() ?? "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const folderMode = opts.folder === undefined ? "all" : opts.folder === DOC_FOLDER_ROOT ? "root" : "id";
  const folderId = folderMode === "id" ? opts.folder! : null;
  if (folderId !== null && !isUuid(folderId)) return [];
  const inFolder = (d: DocumentRecord) => folderMode === "all" || d.doc_folder_id === folderId;
  if (!hasDb()) {
    const needle = q.toLowerCase();
    return [...memory.docs.values()]
      .filter((d) => d.team_id === teamId && d.archived === archived && inFolder(d))
      .filter((d) => !needle || d.title.toLowerCase().includes(needle) || d.content_text.toLowerCase().includes(needle))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map(summarize);
  }
  await schema();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const { rows } = await sql`
    SELECT id, team_id, title, type_key, type_source, type_confidence, last_classified_at, archived, doc_folder_id, created_by, updated_by, created_at, updated_at,
           LEFT(content_text, 200) AS excerpt
      FROM document
     WHERE team_id = ${teamId} AND archived = ${archived}
       AND (${q} = '' OR title ILIKE ${like} OR content_text ILIKE ${like})
       AND (${folderMode} = 'all'
            OR (${folderMode} = 'root' AND doc_folder_id IS NULL)
            OR doc_folder_id = ${folderId}::uuid)
     ORDER BY updated_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => {
    const rec = rowToRecord({ ...r, content_json: EMPTY_DOC, content_text: "" });
    return summarize({ ...rec, content_text: String(r.excerpt ?? "") });
  });
}

export async function getDocument(teamId: string, id: string): Promise<DocumentRecord | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    const d = memory.docs.get(id);
    return d && d.team_id === teamId ? d : null;
  }
  await schema();
  const { rows } = await sql`SELECT * FROM document WHERE id = ${id} AND team_id = ${teamId}`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export type DocumentInit = { title?: string; type_key?: string | null; content_json?: PMNode };

export async function createDocument(teamId: string, agent: string, init: DocumentInit = {}): Promise<DocumentRecord> {
  const content = init.content_json ?? EMPTY_DOC;
  const rec: DocumentRecord = {
    id: randomUUID(),
    team_id: teamId,
    title: (init.title ?? "").slice(0, 300),
    type_key: init.type_key ?? null,
    type_source: init.type_key ? "user" : null,
    type_confidence: null,
    last_classified_at: null,
    classifier_state: parseClassifierState(null),
    content_json: content,
    content_text: docText(content),
    notes: "",
    archived: false,
    doc_folder_id: null,
    created_by: agent,
    updated_by: agent,
    created_at: nowIso(),
    updated_at: "",
  };
  rec.updated_at = rec.created_at;
  if (!hasDb()) {
    memory.docs.set(rec.id, rec);
    return rec;
  }
  await schema();
  const { rows } = await sql`
    INSERT INTO document (id, team_id, title, type_key, type_source, content_json, content_text, created_by, updated_by)
    VALUES (${rec.id}, ${teamId}, ${rec.title}, ${rec.type_key}, ${rec.type_key ? "user" : null},
            ${JSON.stringify(content)}::jsonb, ${rec.content_text}, ${agent}, ${agent})
    RETURNING *`;
  return rowToRecord(rows[0]);
}

export type DocumentPatch = {
  title?: string;
  type_key?: string | null;
  /** With type_key: who chose it (default 'user'). Ignored without type_key. */
  type_source?: Extract<TypeSource, "user" | "classifier">;
  content_json?: PMNode;
  notes?: string;
  archived?: boolean;
  /** Move to a document folder (null: the top level). The caller checks the folder belongs to the team. */
  doc_folder_id?: string | null;
};

export type UpdateResult =
  | { ok: true; doc: DocumentRecord }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; doc: DocumentRecord };

/**
 * Apply a patch. When `expectedUpdatedAt` is given and the stored row is newer,
 * nothing is written and the current row is returned as a conflict.
 */
export async function updateDocument(
  teamId: string,
  id: string,
  agent: string,
  patch: DocumentPatch,
  expectedUpdatedAt?: string,
): Promise<UpdateResult> {
  const current = await getDocument(teamId, id);
  if (!current) return { ok: false, reason: "not_found" };
  if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== new Date(current.updated_at).getTime()) {
    return { ok: false, reason: "conflict", doc: current };
  }
  // Archiving, restoring or moving to a folder isn't an edit: leave updated_at
  // alone, so an editor open on the document (whose next save sends that
  // updated_at as its base) doesn't see its own archive or move as someone
  // else's change.
  const defined = Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "type_source");
  const organizeOnly = defined.length > 0 && defined.every(([k]) => ORGANIZE_KEYS.has(k));
  const next: DocumentRecord = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title.slice(0, 300) } : {}),
    ...(patch.type_key !== undefined ? { type_key: patch.type_key, type_source: patch.type_key ? (patch.type_source ?? "user") : null } : {}),
    ...(patch.content_json !== undefined ? { content_json: patch.content_json, content_text: docText(patch.content_json) } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.doc_folder_id !== undefined ? { doc_folder_id: patch.doc_folder_id } : {}),
    ...(organizeOnly ? {} : { updated_by: agent, updated_at: nowIso() }),
  };
  const moved = next.doc_folder_id !== current.doc_folder_id ? [current.doc_folder_id, next.doc_folder_id] : [];
  if (!hasDb()) {
    memory.docs.set(id, next);
    await touchDocFolders(teamId, moved);
    return { ok: true, doc: next };
  }
  // The WHERE clause repeats the version check so two concurrent saves can't
  // both pass the read above. JavaScript dates carry milliseconds and Postgres
  // keeps microseconds, so the stored value is compared at millisecond precision.
  const { rows } = await sql`
    UPDATE document SET
      title = ${next.title}, type_key = ${next.type_key},
      type_source = CASE WHEN ${patch.type_key !== undefined} THEN ${next.type_source} ELSE type_source END,
      content_json = ${JSON.stringify(next.content_json)}::jsonb, content_text = ${next.content_text},
      notes = ${next.notes}, archived = ${next.archived}, doc_folder_id = ${next.doc_folder_id}::uuid,
      updated_by = CASE WHEN ${organizeOnly} THEN updated_by ELSE ${agent} END,
      updated_at = CASE WHEN ${organizeOnly} THEN updated_at ELSE now() END
    WHERE id = ${id} AND team_id = ${teamId}
      AND date_trunc('milliseconds', updated_at) = ${current.updated_at}::timestamptz
    RETURNING *`;
  if (!rows[0]) {
    const latest = await getDocument(teamId, id);
    return latest ? { ok: false, reason: "conflict", doc: latest } : { ok: false, reason: "not_found" };
  }
  await touchDocFolders(teamId, moved);
  return { ok: true, doc: rowToRecord(rows[0]) };
}

const ORGANIZE_KEYS = new Set(["archived", "doc_folder_id"]);

/**
 * Bump the updated_at of document folders that documents moved into or out of
 * (the date the panel shows). Nulls, duplicates and other teams' folders are ignored.
 */
export async function touchDocFolders(teamId: string, folderIds: Array<string | null>): Promise<void> {
  const ids = [...new Set(folderIds.filter((f): f is string => !!f && isUuid(f)))];
  if (ids.length === 0) return;
  if (!hasDb()) {
    for (const id of ids) {
      const f = docFolderMemory.get(id);
      if (f && f.team_id === teamId) f.updated_at = nowIso();
    }
    return;
  }
  await schema();
  await sql.query(`UPDATE document_folder SET updated_at = now() WHERE team_id = $1 AND id = ANY($2::uuid[])`, [teamId, ids]);
}

export type BulkResult = { done: string[]; missing: string[] };

/**
 * Archive, restore, delete or move many documents at once. Ids not in the
 * team come back in `missing` and are left alone. Like single-document
 * archives and moves, none of these bump a document's updated_at. The caller
 * checks that a move's target folder belongs to the team.
 */
export async function bulkDocuments(teamId: string, agent: string, body: BulkDocumentsBody): Promise<BulkResult> {
  void agent; // Organizing isn't an edit, so updated_by stays; kept for symmetry with updateDocument.
  // Postgres returns ids in lower case; compare in lower case so `done` matches.
  const requested = [...new Set(body.ids.map((id) => id.toLowerCase()))];
  const ids = requested.filter(isUuid);
  const target = body.action === "move" ? (body.doc_folder_id?.toLowerCase() ?? null) : null;
  const found = new Set<string>();
  const touched: Array<string | null> = [];
  if (!hasDb()) {
    for (const id of ids) {
      const d = memory.docs.get(id);
      if (!d || d.team_id !== teamId) continue;
      found.add(id);
      if (body.action === "delete") memory.docs.delete(id);
      else if (body.action === "move") {
        if (d.doc_folder_id !== target) touched.push(d.doc_folder_id, target);
        memory.docs.set(id, { ...d, doc_folder_id: target });
      } else memory.docs.set(id, { ...d, archived: body.action === "archive" });
    }
  } else if (ids.length > 0) {
    await schema();
    let rows: Array<Record<string, unknown>>;
    if (body.action === "delete") {
      ({ rows } = await sql.query(`DELETE FROM document WHERE team_id = $1 AND id = ANY($2::uuid[]) RETURNING id`, [teamId, ids]));
    } else if (body.action === "move") {
      // The CTE reads each row's folder before the update, so the folders the
      // documents left can be touched too.
      ({ rows } = await sql.query(
        `WITH prev AS (
           SELECT id, doc_folder_id FROM document WHERE team_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE)
         UPDATE document d SET doc_folder_id = $3::uuid
           FROM prev WHERE d.id = prev.id
         RETURNING d.id, prev.doc_folder_id AS prev_folder_id`,
        [teamId, ids, target],
      ));
      for (const r of rows) {
        const prevFolder = r.prev_folder_id == null ? null : String(r.prev_folder_id);
        if (prevFolder !== target) touched.push(prevFolder, target);
      }
    } else {
      ({ rows } = await sql.query(`UPDATE document SET archived = $3 WHERE team_id = $1 AND id = ANY($2::uuid[]) RETURNING id`, [
        teamId,
        ids,
        body.action === "archive",
      ]));
    }
    for (const r of rows) found.add(String(r.id));
  }
  await touchDocFolders(teamId, touched);
  return {
    done: ids.filter((id) => found.has(id)),
    missing: requested.filter((id) => !found.has(id)),
  };
}

export async function deleteDocument(teamId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  if (!hasDb()) {
    const d = memory.docs.get(id);
    if (!d || d.team_id !== teamId) return false;
    memory.docs.delete(id);
    return true;
  }
  await schema();
  const { rowCount } = await sql`DELETE FROM document WHERE id = ${id} AND team_id = ${teamId}`;
  return (rowCount ?? 0) > 0;
}

// --- Versions ------------------------------------------------------------------

/** Snapshot the document's current body (before a rewrite, restructure or delete of a section). */
export async function snapshotVersion(teamId: string, id: string, agent: string, reason: string): Promise<VersionRecord | null> {
  const doc = await getDocument(teamId, id);
  if (!doc) return null;
  if (!hasDb()) {
    const v = { id: memory.versions.length + 1, document_id: id, title: doc.title, reason, created_by: agent, created_at: nowIso(), content_json: doc.content_json };
    memory.versions.push(v);
    const { content_json: _c, ...rest } = v;
    void _c;
    return rest;
  }
  const { rows } = await sql`
    INSERT INTO document_version (document_id, content_json, title, reason, created_by)
    VALUES (${id}, ${JSON.stringify(doc.content_json)}::jsonb, ${doc.title}, ${reason.slice(0, 200)}, ${agent})
    RETURNING id, document_id, title, reason, created_by, created_at`;
  const r = rows[0];
  return { id: Number(r.id), document_id: String(r.document_id), title: r.title, reason: r.reason, created_by: r.created_by, created_at: iso(r.created_at) };
}

export async function listVersions(teamId: string, id: string): Promise<VersionRecord[]> {
  const doc = await getDocument(teamId, id);
  if (!doc) return [];
  if (!hasDb()) {
    return memory.versions
      .filter((v) => v.document_id === id)
      .reverse()
      .map(({ content_json: _c, ...rest }) => (void _c, rest));
  }
  const { rows } = await sql`
    SELECT id, document_id, title, reason, created_by, created_at FROM document_version
     WHERE document_id = ${id} ORDER BY id DESC LIMIT 100`;
  return rows.map((r) => ({ id: Number(r.id), document_id: String(r.document_id), title: r.title, reason: r.reason, created_by: r.created_by, created_at: iso(r.created_at) }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);
