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
  `CREATE TABLE IF NOT EXISTS document_version (
     id BIGSERIAL PRIMARY KEY,
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     content_json JSONB NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     reason TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS document_version_doc_idx ON document_version (document_id, id DESC)`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("documents", DOCUMENT_SCHEMA);

export type DocumentRecord = {
  id: string;
  team_id: string;
  title: string;
  type_key: string | null;
  content_json: PMNode;
  content_text: string;
  notes: string;
  archived: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type DocumentSummary = Omit<DocumentRecord, "content_json" | "content_text" | "notes"> & { excerpt: string };

export type VersionRecord = { id: number; document_id: string; title: string; reason: string; created_by: string; created_at: string };

const iso = (v: unknown) => new Date(v as string).toISOString();

function rowToRecord(r: Record<string, unknown>): DocumentRecord {
  return {
    id: String(r.id),
    team_id: String(r.team_id),
    title: String(r.title ?? ""),
    type_key: (r.type_key as string | null) ?? null,
    content_json: (r.content_json as PMNode) ?? EMPTY_DOC,
    content_text: String(r.content_text ?? ""),
    notes: String(r.notes ?? ""),
    archived: !!r.archived,
    created_by: String(r.created_by),
    updated_by: String(r.updated_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function summarize(d: DocumentRecord): DocumentSummary {
  const { content_json: _c, content_text, notes: _n, ...rest } = d;
  void _c;
  void _n;
  return { ...rest, excerpt: content_text.slice(0, 200) };
}

// --- In-memory fallback -------------------------------------------------------

const memory = {
  docs: new Map<string, DocumentRecord>(),
  versions: [] as Array<VersionRecord & { content_json: PMNode }>,
};

/** Clears the in-memory store (tests). */
export function resetMemoryStore() {
  memory.docs.clear();
  memory.versions.length = 0;
}

// Timestamps must strictly increase per document so a conflict check on
// `updated_at` can't be fooled by two saves in the same millisecond.
let lastStamp = 0;
function nowIso(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

// --- Queries -------------------------------------------------------------------

export async function listDocuments(teamId: string, opts: { archived?: boolean; query?: string; limit?: number } = {}): Promise<DocumentSummary[]> {
  const archived = !!opts.archived;
  const q = opts.query?.trim() ?? "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (!hasDb()) {
    const needle = q.toLowerCase();
    return [...memory.docs.values()]
      .filter((d) => d.team_id === teamId && d.archived === archived)
      .filter((d) => !needle || d.title.toLowerCase().includes(needle) || d.content_text.toLowerCase().includes(needle))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map(summarize);
  }
  await schema();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const { rows } = await sql`
    SELECT id, team_id, title, type_key, archived, created_by, updated_by, created_at, updated_at,
           LEFT(content_text, 200) AS excerpt
      FROM document
     WHERE team_id = ${teamId} AND archived = ${archived}
       AND (${q} = '' OR title ILIKE ${like} OR content_text ILIKE ${like})
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
    content_json: content,
    content_text: docText(content),
    notes: "",
    archived: false,
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
  content_json?: PMNode;
  notes?: string;
  archived?: boolean;
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
  const next: DocumentRecord = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title.slice(0, 300) } : {}),
    ...(patch.type_key !== undefined ? { type_key: patch.type_key } : {}),
    ...(patch.content_json !== undefined ? { content_json: patch.content_json, content_text: docText(patch.content_json) } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    updated_by: agent,
    updated_at: nowIso(),
  };
  if (!hasDb()) {
    memory.docs.set(id, next);
    return { ok: true, doc: next };
  }
  // The WHERE clause repeats the version check so two concurrent saves can't
  // both pass the read above. JavaScript dates carry milliseconds and Postgres
  // keeps microseconds, so the stored value is compared at millisecond precision.
  const { rows } = await sql`
    UPDATE document SET
      title = ${next.title}, type_key = ${next.type_key},
      type_source = CASE WHEN ${patch.type_key !== undefined} THEN 'user' ELSE type_source END,
      content_json = ${JSON.stringify(next.content_json)}::jsonb, content_text = ${next.content_text},
      notes = ${next.notes}, archived = ${next.archived}, updated_by = ${agent}, updated_at = now()
    WHERE id = ${id} AND team_id = ${teamId}
      AND date_trunc('milliseconds', updated_at) = ${current.updated_at}::timestamptz
    RETURNING *`;
  if (!rows[0]) {
    const latest = await getDocument(teamId, id);
    return latest ? { ok: false, reason: "conflict", doc: latest } : { ok: false, reason: "not_found" };
  }
  return { ok: true, doc: rowToRecord(rows[0]) };
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
