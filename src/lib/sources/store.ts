// The sources library: files, links and notes a team writes from, organized in
// folders and linked to documents. A source belongs to a team; `team_id` is
// stored on every source (not only through its folder) so each query can scope
// to the team without a join. Every function takes the caller's team, and a row
// from another team behaves exactly like a missing one.
//
// Each document gets its own folder the first time a source is added to it
// (ensureDocumentFolder). Folders nest; deleting one deletes its subfolders and
// moves the sources inside to the library root. Deleting a document removes its
// links (foreign-key cascade) but keeps the sources.
//
// Extracted text is split into passages with stable ids (`S1a2b3c4d.P7`) that
// drafting cites; re-extracting a source replaces its passages.
//
// Without POSTGRES_URL (local development, tests) everything lives in process
// memory and does not survive a restart.

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { DOCUMENT_SCHEMA, getDocument, isUuid } from "@/lib/documents/store";

export const SOURCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS folder (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     parent_id UUID REFERENCES folder(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     document_id UUID,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS folder_team_parent_idx ON folder (team_id, parent_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS folder_team_document_uidx ON folder (team_id, document_id) WHERE document_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS source (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     folder_id UUID REFERENCES folder(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK (kind IN ('file', 'url', 'note')),
     title TEXT,
     filename TEXT,
     mime TEXT,
     bytes INTEGER,
     blob_url TEXT,
     blob_pathname TEXT,
     url TEXT,
     extracted_text TEXT,
     extraction_status TEXT NOT NULL DEFAULT 'pending',
     extraction_error TEXT,
     summary TEXT,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS source_team_folder_idx ON source (team_id, folder_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS document_source (
     document_id UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
     source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
     role TEXT,
     added_by TEXT NOT NULL,
     added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (document_id, source_id))`,
  `CREATE INDEX IF NOT EXISTS document_source_source_idx ON document_source (source_id)`,
  `CREATE TABLE IF NOT EXISTS source_passage (
     source_id UUID NOT NULL REFERENCES source(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL,
     id TEXT NOT NULL,
     page INTEGER,
     start_offset INTEGER NOT NULL,
     end_offset INTEGER NOT NULL,
     text TEXT NOT NULL,
     PRIMARY KEY (source_id, idx))`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
// document_source references document, so the document tables come first.
const schema = () => ensureSchema("sources", [...DOCUMENT_SCHEMA, ...SOURCE_SCHEMA]);

export type SourceKind = "file" | "url" | "note";
export type ExtractionStatus = "uploading" | "pending" | "extracting" | "summarizing" | "ready" | "partial" | "error";
/** Statuses after which nothing more happens until someone retries. */
export const TERMINAL_STATUSES: ExtractionStatus[] = ["ready", "partial", "error"];

export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  document_id: string | null;
  created_by: string;
  created_at: string;
};

/** A source as the API lists it: no extracted text, no storage details. */
export type SourceSummary = {
  id: string;
  kind: SourceKind;
  title: string | null;
  filename: string | null;
  mime: string | null;
  bytes: number | null;
  url: string | null;
  folder_id: string | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  document_ids: string[];
};

export type SourceDetail = SourceSummary & { extracted_text: string | null };
export type LinkedSource = SourceSummary & { role: string | null; added_at: string };

/** The full row, for server code (ingest, file serving). */
export type SourceRecord = SourceDetail & {
  team_id: string;
  blob_url: string | null;
  blob_pathname: string | null;
  created_by: string;
};

export type StoredPassage = { id: string; idx: number; page: number | null; start_offset: number; end_offset: number; text: string };

type FolderRow = Folder & { team_id: string };
type LinkRow = { document_id: string; source_id: string; role: string | null; added_by: string; added_at: string };

const iso = (v: unknown) => new Date(v as string).toISOString();
const str = (v: unknown) => (v == null ? null : String(v));

function rowToFolder(r: Record<string, unknown>): Folder {
  return {
    id: String(r.id),
    parent_id: str(r.parent_id),
    name: String(r.name ?? ""),
    document_id: str(r.document_id),
    created_by: String(r.created_by ?? ""),
    created_at: iso(r.created_at),
  };
}

function rowToSource(r: Record<string, unknown>): SourceRecord {
  return {
    id: String(r.id),
    team_id: String(r.team_id ?? ""),
    kind: r.kind as SourceKind,
    title: str(r.title),
    filename: str(r.filename),
    mime: str(r.mime),
    bytes: r.bytes == null ? null : Number(r.bytes),
    url: str(r.url),
    folder_id: str(r.folder_id),
    blob_url: str(r.blob_url),
    blob_pathname: str(r.blob_pathname),
    extracted_text: str(r.extracted_text),
    extraction_status: (r.extraction_status as ExtractionStatus) ?? "pending",
    extraction_error: str(r.extraction_error),
    summary: str(r.summary),
    created_by: String(r.created_by ?? ""),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    document_ids: Array.isArray(r.document_ids) ? r.document_ids.map(String) : [],
  };
}

/**
 * A busy status this old was left by a run that was stopped (a function killed
 * at its time limit, a crashed instance): ingest finishes each step well inside
 * the 300s function limit (ingest.ts), so it never sits this long in one.
 */
export const STALE_BUSY_MS = 6 * 60_000;
/** An upload not reported this long after presign never will be (the tab closed, or completing failed). */
export const STALE_UPLOAD_MS = 60 * 60_000;

const STALE_MESSAGES: Partial<Record<ExtractionStatus, string>> = {
  uploading: "The upload didn't finish. Remove it and upload it again.",
  pending: "Reading this source stopped before it finished. Read it again.",
  extracting: "Reading this source stopped before it finished. Read it again.",
  summarizing: "Reading this source stopped before it finished. Read it again.",
};

/**
 * The status to report: a busy status that has gone stale reads as an error,
 * so the person can retry or remove it and the screens stop polling it.
 */
export function reportedStatus(s: Pick<SourceRecord, "extraction_status" | "extraction_error" | "updated_at">, now = Date.now()): { status: ExtractionStatus; error: string | null } {
  const message = STALE_MESSAGES[s.extraction_status];
  const limit = s.extraction_status === "uploading" ? STALE_UPLOAD_MS : STALE_BUSY_MS;
  if (message && now - new Date(s.updated_at).getTime() > limit) return { status: "error", error: message };
  return { status: s.extraction_status, error: s.extraction_error };
}

export function toSummary(s: SourceRecord): SourceSummary {
  const reported = reportedStatus(s);
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    filename: s.filename,
    mime: s.mime,
    bytes: s.bytes,
    url: s.url,
    folder_id: s.folder_id,
    extraction_status: reported.status,
    extraction_error: reported.error,
    summary: s.summary,
    created_at: s.created_at,
    updated_at: s.updated_at,
    document_ids: s.document_ids,
  };
}

export function toDetail(s: SourceRecord): SourceDetail {
  return { ...toSummary(s), extracted_text: s.extracted_text };
}

// --- In-memory fallback -------------------------------------------------------

const memory = {
  folders: new Map<string, FolderRow>(),
  sources: new Map<string, SourceRecord>(),
  links: new Map<string, LinkRow>(),
  passages: new Map<string, StoredPassage[]>(),
};

const linkKey = (documentId: string, sourceId: string) => `${documentId}:${sourceId}`;

/** Clears the in-memory store (tests). */
export function resetSourceStore() {
  memory.folders.clear();
  memory.sources.clear();
  memory.links.clear();
  memory.passages.clear();
}

let lastStamp = 0;
function nowIso(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

function memoryDocumentIds(sourceId: string): string[] {
  return [...memory.links.values()].filter((l) => l.source_id === sourceId).map((l) => l.document_id);
}

function memorySource(teamId: string, id: string): SourceRecord | null {
  const s = memory.sources.get(id);
  return s && s.team_id === teamId ? { ...s, document_ids: memoryDocumentIds(id) } : null;
}

const stripTeam = ({ team_id: _t, ...f }: FolderRow): Folder => (void _t, f);

// --- Folders -------------------------------------------------------------------

export async function listFolders(teamId: string): Promise<Folder[]> {
  if (!hasDb()) {
    return [...memory.folders.values()]
      .filter((f) => f.team_id === teamId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.created_at.localeCompare(b.created_at))
      .map(stripTeam);
  }
  await schema();
  const { rows } = await sql`SELECT * FROM folder WHERE team_id = ${teamId} ORDER BY lower(name), created_at`;
  return rows.map(rowToFolder);
}

export async function getFolder(teamId: string, id: string): Promise<Folder | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    const f = memory.folders.get(id);
    return f && f.team_id === teamId ? stripTeam(f) : null;
  }
  await schema();
  const { rows } = await sql`SELECT * FROM folder WHERE id = ${id} AND team_id = ${teamId}`;
  return rows[0] ? rowToFolder(rows[0]) : null;
}

export type FolderResult = { ok: true; folder: Folder } | { ok: false; reason: "not_found" | "parent_not_found" | "cycle" };

export async function createFolder(teamId: string, agent: string, init: { name: string; parent_id?: string | null }): Promise<FolderResult> {
  const parentId = init.parent_id ?? null;
  if (parentId && !(await getFolder(teamId, parentId))) return { ok: false, reason: "parent_not_found" };
  const folder = await insertFolder(teamId, agent, { name: init.name, parent_id: parentId, document_id: null });
  return { ok: true, folder };
}

async function insertFolder(teamId: string, agent: string, f: { name: string; parent_id: string | null; document_id: string | null }): Promise<Folder> {
  const rec: FolderRow = { id: randomUUID(), team_id: teamId, parent_id: f.parent_id, name: f.name.slice(0, 200), document_id: f.document_id, created_by: agent, created_at: nowIso() };
  if (!hasDb()) {
    memory.folders.set(rec.id, rec);
    return stripTeam(rec);
  }
  await schema();
  const { rows } = await sql`
    INSERT INTO folder (id, team_id, parent_id, name, document_id, created_by)
    VALUES (${rec.id}, ${teamId}, ${rec.parent_id}, ${rec.name}, ${rec.document_id}, ${agent})
    RETURNING *`;
  return rowToFolder(rows[0]);
}

/** True when making `parentId` the parent of `id` would put `id` inside itself. */
export function wouldCycle(folders: Array<Pick<Folder, "id" | "parent_id">>, id: string, parentId: string | null): boolean {
  const parentOf = new Map(folders.map((f) => [f.id, f.parent_id]));
  const seen = new Set<string>();
  for (let cur = parentId; cur; cur = parentOf.get(cur) ?? null) {
    if (cur === id) return true;
    if (seen.has(cur)) return true; // an existing loop; refuse rather than spin
    seen.add(cur);
  }
  return false;
}

export async function updateFolder(teamId: string, id: string, patch: { name?: string; parent_id?: string | null }): Promise<FolderResult> {
  const current = await getFolder(teamId, id);
  if (!current) return { ok: false, reason: "not_found" };
  const parentId = patch.parent_id === undefined ? current.parent_id : patch.parent_id;
  if (patch.parent_id !== undefined && parentId) {
    const folders = await listFolders(teamId);
    if (!folders.some((f) => f.id === parentId)) return { ok: false, reason: "parent_not_found" };
    if (wouldCycle(folders, id, parentId)) return { ok: false, reason: "cycle" };
  }
  const name = patch.name !== undefined ? patch.name.slice(0, 200) : current.name;
  if (!hasDb()) {
    const row = memory.folders.get(id)!;
    const next = { ...row, name, parent_id: parentId };
    memory.folders.set(id, next);
    return { ok: true, folder: stripTeam(next) };
  }
  const { rows } = await sql`
    UPDATE folder SET name = ${name}, parent_id = ${parentId}
     WHERE id = ${id} AND team_id = ${teamId}
    RETURNING *`;
  return rows[0] ? { ok: true, folder: rowToFolder(rows[0]) } : { ok: false, reason: "not_found" };
}

/** Delete a folder and its subfolders; the sources inside move to the library root. */
export async function deleteFolder(teamId: string, id: string): Promise<boolean> {
  const current = await getFolder(teamId, id);
  if (!current) return false;
  const folders = await listFolders(teamId);
  const doomed = new Set([id]);
  // Collect descendants (the database cascades them; memory and the document
  // pointers need the list).
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && doomed.has(f.parent_id) && !doomed.has(f.id)) {
        doomed.add(f.id);
        grew = true;
      }
    }
  }
  if (!hasDb()) {
    for (const fid of doomed) memory.folders.delete(fid);
    for (const s of memory.sources.values()) {
      if (s.team_id === teamId && s.folder_id && doomed.has(s.folder_id)) memory.sources.set(s.id, { ...s, folder_id: null });
    }
    return true;
  }
  const ids = [...doomed];
  await sql.query(`UPDATE document SET folder_id = NULL WHERE team_id = $1 AND folder_id = ANY($2::uuid[])`, [teamId, ids]);
  const { rowCount } = await sql`DELETE FROM folder WHERE id = ${id} AND team_id = ${teamId}`;
  return (rowCount ?? 0) > 0;
}

/**
 * The document's own folder, created on first use and named after the
 * document. Idempotent (a unique index backs it, so two concurrent uploads get
 * the same folder). Returns null when the document isn't the team's.
 */
export async function ensureDocumentFolder(teamId: string, agent: string, documentId: string): Promise<Folder | null> {
  const doc = await getDocument(teamId, documentId);
  if (!doc) return null;
  const name = doc.title.trim() || "Untitled document";
  if (!hasDb()) {
    const existing = [...memory.folders.values()].find((f) => f.team_id === teamId && f.document_id === documentId);
    return existing ? stripTeam(existing) : insertFolder(teamId, agent, { name, parent_id: null, document_id: documentId });
  }
  await schema();
  await sql`
    INSERT INTO folder (id, team_id, parent_id, name, document_id, created_by)
    VALUES (${randomUUID()}, ${teamId}, NULL, ${name.slice(0, 200)}, ${documentId}, ${agent})
    ON CONFLICT (team_id, document_id) WHERE document_id IS NOT NULL DO NOTHING`;
  const { rows } = await sql`SELECT * FROM folder WHERE team_id = ${teamId} AND document_id = ${documentId}`;
  const folder = rowToFolder(rows[0]);
  await sql`
    UPDATE document SET folder_id = ${folder.id}
     WHERE id = ${documentId} AND team_id = ${teamId} AND folder_id IS DISTINCT FROM ${folder.id}::uuid`;
  return folder;
}

export type TargetFolder = { ok: true; folderId: string | null } | { ok: false; reason: "folder_not_found" | "document_not_found" };

/**
 * Where a new source goes: the document's folder when a document is named
 * (it wins over folder_id), else the given folder, else the library root.
 */
export async function targetFolder(teamId: string, agent: string, opts: { folderId?: string | null; documentId?: string | null }): Promise<TargetFolder> {
  if (opts.documentId) {
    const f = await ensureDocumentFolder(teamId, agent, opts.documentId);
    return f ? { ok: true, folderId: f.id } : { ok: false, reason: "document_not_found" };
  }
  if (opts.folderId) {
    return (await getFolder(teamId, opts.folderId)) ? { ok: true, folderId: opts.folderId } : { ok: false, reason: "folder_not_found" };
  }
  return { ok: true, folderId: null };
}

// --- Sources -------------------------------------------------------------------

export type SourceQuery = {
  /** A folder id, or "root" for sources in no folder. Omitted: every folder. */
  folder?: string;
  query?: string;
  documentId?: string;
  ids?: string[];
  kind?: SourceKind;
  limit?: number;
};

const SUMMARY_COLUMNS = `s.id, s.team_id, s.kind, s.title, s.filename, s.mime, s.bytes, s.url, s.folder_id, s.blob_url, s.blob_pathname,
  s.extraction_status, s.extraction_error, s.summary, s.created_by, s.created_at, s.updated_at,
  ARRAY(SELECT ds.document_id::text FROM document_source ds WHERE ds.source_id = s.id ORDER BY ds.added_at) AS document_ids`;

export async function listSources(teamId: string, opts: SourceQuery = {}): Promise<SourceSummary[]> {
  const q = opts.query?.trim() ?? "";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const ids = opts.ids?.filter(isUuid);
  if (opts.ids && !ids?.length) return [];
  if (opts.folder && opts.folder !== "root" && !isUuid(opts.folder)) return [];
  if (opts.documentId && !isUuid(opts.documentId)) return [];
  if (!hasDb()) {
    const needle = q.toLowerCase();
    const hit = (v: string | null) => !!v && v.toLowerCase().includes(needle);
    return [...memory.sources.values()]
      .filter((s) => s.team_id === teamId)
      .map((s) => ({ ...s, document_ids: memoryDocumentIds(s.id) }))
      .filter((s) => !opts.folder || (opts.folder === "root" ? s.folder_id === null : s.folder_id === opts.folder))
      .filter((s) => !opts.kind || s.kind === opts.kind)
      .filter((s) => !ids || ids.includes(s.id))
      .filter((s) => !opts.documentId || s.document_ids.includes(opts.documentId))
      .filter((s) => !needle || hit(s.title) || hit(s.filename) || hit(s.url) || hit(s.summary) || hit(s.extracted_text))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(toSummary);
  }
  await schema();
  const params: unknown[] = [teamId];
  const where = ["s.team_id = $1"];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.folder === "root") where.push("s.folder_id IS NULL");
  else if (opts.folder) where.push(`s.folder_id = ${param(opts.folder)}::uuid`);
  if (opts.kind) where.push(`s.kind = ${param(opts.kind)}`);
  if (ids) where.push(`s.id = ANY(${param(ids)}::uuid[])`);
  if (opts.documentId) where.push(`EXISTS (SELECT 1 FROM document_source ds WHERE ds.source_id = s.id AND ds.document_id = ${param(opts.documentId)}::uuid)`);
  if (q) {
    const like = param(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(s.title ILIKE ${like} OR s.filename ILIKE ${like} OR s.url ILIKE ${like} OR s.summary ILIKE ${like} OR s.extracted_text ILIKE ${like})`);
  }
  const { rows } = await sql.query(
    `SELECT ${SUMMARY_COLUMNS} FROM source s WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC LIMIT ${param(limit)}`,
    params,
  );
  return rows.map((r) => toSummary(rowToSource(r)));
}

export async function getSource(teamId: string, id: string): Promise<SourceRecord | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) return memorySource(teamId, id);
  await schema();
  const { rows } = await sql.query(
    `SELECT ${SUMMARY_COLUMNS}, s.extracted_text FROM source s WHERE s.id = $1 AND s.team_id = $2`,
    [id, teamId],
  );
  return rows[0] ? rowToSource(rows[0]) : null;
}

export type SourceInit = {
  kind: SourceKind;
  folder_id?: string | null;
  title?: string | null;
  filename?: string | null;
  mime?: string | null;
  bytes?: number | null;
  url?: string | null;
  blob_pathname?: string | null;
  extracted_text?: string | null;
  extraction_status?: ExtractionStatus;
  /** Use this id (uploads choose the id before the row exists so the blob path can include it). */
  id?: string;
};

/** Insert a source. The caller has already checked the folder belongs to the team (see targetFolder). */
export async function createSource(teamId: string, agent: string, init: SourceInit): Promise<SourceRecord> {
  const now = nowIso();
  const rec: SourceRecord = {
    id: init.id ?? randomUUID(),
    team_id: teamId,
    kind: init.kind,
    title: init.title?.slice(0, 300) ?? null,
    filename: init.filename?.slice(0, 300) ?? null,
    mime: init.mime ?? null,
    bytes: init.bytes ?? null,
    url: init.url ?? null,
    folder_id: init.folder_id ?? null,
    blob_url: null,
    blob_pathname: init.blob_pathname ?? null,
    extracted_text: init.extracted_text ?? null,
    extraction_status: init.extraction_status ?? "pending",
    extraction_error: null,
    summary: null,
    created_by: agent,
    created_at: now,
    updated_at: now,
    document_ids: [],
  };
  if (!hasDb()) {
    memory.sources.set(rec.id, rec);
    return { ...rec };
  }
  await schema();
  await sql`
    INSERT INTO source (id, team_id, folder_id, kind, title, filename, mime, bytes, url, blob_pathname, extracted_text, extraction_status, created_by)
    VALUES (${rec.id}, ${teamId}, ${rec.folder_id}, ${rec.kind}, ${rec.title}, ${rec.filename}, ${rec.mime}, ${rec.bytes},
            ${rec.url}, ${rec.blob_pathname}, ${rec.extracted_text}, ${rec.extraction_status}, ${agent})`;
  return (await getSource(teamId, rec.id))!;
}

export type SourceResult = { ok: true; source: SourceRecord } | { ok: false; reason: "not_found" | "folder_not_found" };

/** Rename or move a source (folder_id null moves it to the root). */
export async function updateSource(teamId: string, id: string, patch: { title?: string | null; folder_id?: string | null }): Promise<SourceResult> {
  const current = await getSource(teamId, id);
  if (!current) return { ok: false, reason: "not_found" };
  if (patch.folder_id && !(await getFolder(teamId, patch.folder_id))) return { ok: false, reason: "folder_not_found" };
  const title = patch.title !== undefined ? (patch.title?.slice(0, 300) ?? null) : current.title;
  const folderId = patch.folder_id !== undefined ? patch.folder_id : current.folder_id;
  return writeSource(teamId, id, { title, folder_id: folderId });
}

type SourceFields = Partial<
  Pick<SourceRecord, "title" | "folder_id" | "filename" | "mime" | "bytes" | "blob_url" | "blob_pathname" | "extracted_text" | "extraction_status" | "extraction_error" | "summary">
>;

async function writeSource(teamId: string, id: string, fields: SourceFields): Promise<SourceResult> {
  if (!hasDb()) {
    const s = memory.sources.get(id);
    if (!s || s.team_id !== teamId) return { ok: false, reason: "not_found" };
    memory.sources.set(id, { ...s, ...fields, updated_at: nowIso() });
    return { ok: true, source: memorySource(teamId, id)! };
  }
  await schema();
  const keys = Object.keys(fields) as Array<keyof SourceFields>;
  if (!keys.length) {
    const s = await getSource(teamId, id);
    return s ? { ok: true, source: s } : { ok: false, reason: "not_found" };
  }
  // Column names come from the fixed SourceFields keys, never from input.
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const { rowCount } = await sql.query(
    `UPDATE source SET ${sets}, updated_at = now() WHERE id = $1 AND team_id = $2`,
    [id, teamId, ...keys.map((k) => fields[k] ?? null)],
  );
  if (!rowCount) return { ok: false, reason: "not_found" };
  return { ok: true, source: (await getSource(teamId, id))! };
}

export async function setSourceStatus(teamId: string, id: string, status: ExtractionStatus, error: string | null = null): Promise<void> {
  await writeSource(teamId, id, { extraction_status: status, extraction_error: error });
}

/** Record where a source's file is stored (after an upload, or a PDF fetched from a link). */
export async function setSourceFile(
  teamId: string,
  id: string,
  file: { blob_url: string; blob_pathname: string; bytes: number | null; mime: string | null; filename?: string | null; status?: ExtractionStatus },
): Promise<SourceRecord | null> {
  const r = await writeSource(teamId, id, {
    blob_url: file.blob_url,
    blob_pathname: file.blob_pathname,
    bytes: file.bytes,
    mime: file.mime,
    ...(file.filename !== undefined ? { filename: file.filename } : {}),
    ...(file.status ? { extraction_status: file.status, extraction_error: null } : {}),
  });
  return r.ok ? r.source : null;
}

/** Store the extracted text. A title found during extraction fills in only a missing title. */
export async function setExtraction(
  teamId: string,
  id: string,
  e: { status: ExtractionStatus; text: string | null; error?: string | null; title?: string | null },
): Promise<void> {
  const current = await getSource(teamId, id);
  if (!current) return;
  await writeSource(teamId, id, {
    extraction_status: e.status,
    extracted_text: e.text,
    extraction_error: e.error ?? null,
    ...(e.title && !current.title?.trim() ? { title: e.title.slice(0, 300) } : {}),
  });
}

export async function setSummary(teamId: string, id: string, summary: string | null): Promise<void> {
  await writeSource(teamId, id, { summary });
}

/** Set a title only when the source has none (a person's title always wins). */
export async function setTitleIfMissing(teamId: string, id: string, title: string): Promise<void> {
  const current = await getSource(teamId, id);
  if (!current || current.title?.trim() || !title.trim()) return;
  await writeSource(teamId, id, { title: title.trim().slice(0, 300) });
}

/** Delete a source (its links and passages cascade). Returns the deleted row so the caller can remove its blob. */
export async function deleteSource(teamId: string, id: string): Promise<SourceRecord | null> {
  const current = await getSource(teamId, id);
  if (!current) return null;
  if (!hasDb()) {
    memory.sources.delete(id);
    memory.passages.delete(id);
    for (const [k, l] of memory.links) if (l.source_id === id) memory.links.delete(k);
    return current;
  }
  const { rowCount } = await sql`DELETE FROM source WHERE id = ${id} AND team_id = ${teamId}`;
  return rowCount ? current : null;
}

// --- Links ---------------------------------------------------------------------

/** Link a source to a document. Both must be the team's. Re-linking updates the role. */
export async function linkSource(
  teamId: string,
  agent: string,
  documentId: string,
  sourceId: string,
  role: string | null = null,
): Promise<"ok" | "document_not_found" | "source_not_found"> {
  if (!(await getDocument(teamId, documentId))) return "document_not_found";
  if (!(await getSource(teamId, sourceId))) return "source_not_found";
  if (!hasDb()) {
    const k = linkKey(documentId, sourceId);
    const existing = memory.links.get(k);
    memory.links.set(k, existing ? { ...existing, role: role ?? existing.role } : { document_id: documentId, source_id: sourceId, role, added_by: agent, added_at: nowIso() });
    return "ok";
  }
  await sql`
    INSERT INTO document_source (document_id, source_id, role, added_by)
    VALUES (${documentId}, ${sourceId}, ${role}, ${agent})
    ON CONFLICT (document_id, source_id) DO UPDATE SET role = COALESCE(EXCLUDED.role, document_source.role)`;
  return "ok";
}

export async function unlinkSource(teamId: string, documentId: string, sourceId: string): Promise<boolean> {
  if (!(await getDocument(teamId, documentId))) return false;
  if (!(await getSource(teamId, sourceId))) return false;
  if (!hasDb()) return memory.links.delete(linkKey(documentId, sourceId));
  const { rowCount } = await sql`DELETE FROM document_source WHERE document_id = ${documentId} AND source_id = ${sourceId}`;
  return (rowCount ?? 0) > 0;
}

/** The document's linked sources, oldest link first; null when the document isn't the team's. */
export async function listDocumentSources(teamId: string, documentId: string): Promise<LinkedSource[] | null> {
  if (!(await getDocument(teamId, documentId))) return null;
  if (!hasDb()) {
    return [...memory.links.values()]
      .filter((l) => l.document_id === documentId)
      .sort((a, b) => a.added_at.localeCompare(b.added_at))
      .flatMap((l) => {
        const s = memorySource(teamId, l.source_id);
        return s ? [{ ...toSummary(s), role: l.role, added_at: l.added_at }] : [];
      });
  }
  const { rows } = await sql.query(
    `SELECT ${SUMMARY_COLUMNS}, ds.role, ds.added_at AS link_added_at
       FROM document_source ds JOIN source s ON s.id = ds.source_id
      WHERE ds.document_id = $1 AND s.team_id = $2
      ORDER BY ds.added_at`,
    [documentId, teamId],
  );
  return rows.map((r) => ({ ...toSummary(rowToSource(r)), role: str(r.role), added_at: iso(r.link_added_at) }));
}

// --- Passages ------------------------------------------------------------------

/** Replace a source's passages (after each extraction). */
export async function replacePassages(teamId: string, sourceId: string, passages: StoredPassage[]): Promise<boolean> {
  if (!(await getSource(teamId, sourceId))) return false;
  if (!hasDb()) {
    memory.passages.set(sourceId, passages.map((p) => ({ ...p })));
    return true;
  }
  await sql`DELETE FROM source_passage WHERE source_id = ${sourceId}`;
  if (passages.length) {
    await sql.query(
      `INSERT INTO source_passage (source_id, idx, id, page, start_offset, end_offset, text)
       SELECT $1::uuid, * FROM unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::int[], $7::text[])`,
      [
        sourceId,
        passages.map((p) => p.idx),
        passages.map((p) => p.id),
        passages.map((p) => p.page),
        passages.map((p) => p.start_offset),
        passages.map((p) => p.end_offset),
        passages.map((p) => p.text),
      ],
    );
  }
  return true;
}

/** A source's passages in order; null when the source isn't the team's. */
export async function listPassages(teamId: string, sourceId: string): Promise<StoredPassage[] | null> {
  if (!(await getSource(teamId, sourceId))) return null;
  if (!hasDb()) return (memory.passages.get(sourceId) ?? []).map((p) => ({ ...p }));
  const { rows } = await sql`
    SELECT id, idx, page, start_offset, end_offset, text FROM source_passage
     WHERE source_id = ${sourceId} ORDER BY idx`;
  return rows.map((r) => ({
    id: String(r.id),
    idx: Number(r.idx),
    page: r.page == null ? null : Number(r.page),
    start_offset: Number(r.start_offset),
    end_offset: Number(r.end_offset),
    text: String(r.text),
  }));
}
