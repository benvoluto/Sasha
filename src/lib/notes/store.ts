// Standalone notes (redesign3-spec.md §7): one plain-text body per row, owned
// by a team. Saves use optimistic concurrency like documents: the client sends
// the `updated_at` it last saw, and a save over a newer version is refused with
// the current row so the dialog can offer "Load theirs" / "Keep mine".
//
// Without POSTGRES_URL (local development, tests) notes live in process memory
// and are cleared with the documents store (resetMemoryStore).

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { isUuid, nowIso, onMemoryStoreReset } from "@/lib/documents/store";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { processMemory } from "@/lib/process-memory";
import { MAX_NOTE_BODY, NOTES_FEED_LIMIT, type Note } from "./contract";

export const NOTE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS note (
     id UUID PRIMARY KEY,
     team_id TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     created_by TEXT NOT NULL,
     updated_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS note_team_updated_idx ON note (team_id, updated_at DESC)`,
];

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("notes", NOTE_SCHEMA);

type NoteRow = Note & { team_id: string };

const memory = processMemory("notes", () => new Map<string, NoteRow>());
onMemoryStoreReset(() => memory.clear());

const iso = (v: unknown) => new Date(v as string).toISOString();

function rowToNote(r: Record<string, unknown>): Note {
  return {
    id: String(r.id),
    body: String(r.body ?? ""),
    created_by: String(r.created_by),
    updated_by: String(r.updated_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function strip({ team_id: _t, ...note }: NoteRow): Note {
  void _t;
  return note;
}

const cap = (body: string) => body.slice(0, MAX_NOTE_BODY);

export type ListNotesOptions = { query?: string; limit?: number };

/** The team's notes, newest first; `query` matches the body, ignoring case. */
export async function listNotes(teamId: string, opts: ListNotesOptions = {}): Promise<Note[]> {
  const q = opts.query?.trim() ?? "";
  const limit = Math.min(Math.max(opts.limit ?? NOTES_FEED_LIMIT, 1), NOTES_FEED_LIMIT);
  if (!hasDb()) {
    const needle = q.toLowerCase();
    return [...memory.values()]
      .filter((n) => n.team_id === teamId && (!needle || n.body.toLowerCase().includes(needle)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map(strip);
  }
  await schema();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const { rows } = await sql`
    SELECT id, body, created_by, updated_by, created_at, updated_at
      FROM note
     WHERE team_id = ${teamId} AND (${q} = '' OR body ILIKE ${like})
     ORDER BY updated_at DESC
     LIMIT ${limit}`;
  return rows.map(rowToNote);
}

export async function getNote(teamId: string, id: string): Promise<Note | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    const n = memory.get(id.toLowerCase());
    return n && n.team_id === teamId ? strip(n) : null;
  }
  await schema();
  const { rows } = await sql`SELECT * FROM note WHERE id = ${id} AND team_id = ${teamId}`;
  return rows[0] ? rowToNote(rows[0]) : null;
}

export async function createNote(teamId: string, agent: string, body = ""): Promise<Note> {
  const id = randomUUID();
  const text = cap(body);
  if (!hasDb()) {
    const at = nowIso();
    const row: NoteRow = { id, team_id: teamId, body: text, created_by: agent, updated_by: agent, created_at: at, updated_at: at };
    memory.set(id, row);
    return strip(row);
  }
  await schema();
  const { rows } = await sql`
    INSERT INTO note (id, team_id, body, created_by, updated_by)
    VALUES (${id}, ${teamId}, ${text}, ${agent}, ${agent})
    RETURNING *`;
  return rowToNote(rows[0]);
}

export type UpdateNoteResult = { ok: true; note: Note } | { ok: false; conflict: Note };

/**
 * Save a note's body. When `baseUpdatedAt` is given and the stored row is
 * newer, nothing is written and the current note comes back as the conflict.
 * Null for an unknown id or another team's note.
 */
export async function updateNote(teamId: string, id: string, agent: string, body: string, baseUpdatedAt?: string): Promise<UpdateNoteResult | null> {
  const current = await getNote(teamId, id);
  if (!current) return null;
  if (baseUpdatedAt && new Date(baseUpdatedAt).getTime() !== new Date(current.updated_at).getTime()) {
    return { ok: false, conflict: current };
  }
  const text = cap(body);
  if (!hasDb()) {
    const next: NoteRow = { ...current, team_id: teamId, body: text, updated_by: agent, updated_at: nowIso() };
    memory.set(current.id, next);
    return { ok: true, note: strip(next) };
  }
  // The WHERE clause repeats the version check (at millisecond precision, as
  // updateDocument does) so two concurrent saves can't both pass the read above.
  const { rows } = await sql`
    UPDATE note SET body = ${text}, updated_by = ${agent}, updated_at = now()
     WHERE id = ${id} AND team_id = ${teamId}
       AND date_trunc('milliseconds', updated_at) = ${current.updated_at}::timestamptz
    RETURNING *`;
  if (!rows[0]) {
    const latest = await getNote(teamId, id);
    return latest ? { ok: false, conflict: latest } : null;
  }
  return { ok: true, note: rowToNote(rows[0]) };
}

export async function deleteNote(teamId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  if (!hasDb()) {
    const key = id.toLowerCase();
    const n = memory.get(key);
    if (!n || n.team_id !== teamId) return false;
    memory.delete(key);
    return true;
  }
  await schema();
  const { rowCount } = await sql`DELETE FROM note WHERE id = ${id} AND team_id = ${teamId}`;
  return (rowCount ?? 0) > 0;
}

/**
 * Remove a note and return it, in one step, so only one caller can claim it
 * (start-document must not turn the same note into two documents). Null when
 * it is already gone or belongs to another team.
 */
export async function takeNote(teamId: string, id: string): Promise<Note | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    // No await between the read and the delete, so concurrent calls can't both see the note.
    const key = id.toLowerCase();
    const n = memory.get(key);
    if (!n || n.team_id !== teamId) return null;
    memory.delete(key);
    return strip(n);
  }
  await schema();
  const { rows } = await sql`DELETE FROM note WHERE id = ${id} AND team_id = ${teamId} RETURNING *`;
  return rows[0] ? rowToNote(rows[0]) : null;
}

/** Put back a note taken with takeNote, unchanged, when what it was taken for failed. */
export async function restoreNote(teamId: string, note: Note): Promise<void> {
  if (!hasDb()) {
    memory.set(note.id, { ...note, team_id: teamId });
    return;
  }
  await schema();
  await sql`
    INSERT INTO note (id, team_id, body, created_by, updated_by, created_at, updated_at)
    VALUES (${note.id}, ${teamId}, ${note.body}, ${note.created_by}, ${note.updated_by}, ${note.created_at}, ${note.updated_at})
    ON CONFLICT (id) DO NOTHING`;
}
