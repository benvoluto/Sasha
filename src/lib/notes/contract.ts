// Standalone notes (redesign3-spec.md §7): notes that belong to no document,
// shown with every document's notes on the overview's Notes tab. A note is one
// plain-text body; its title is derived from the first line, never stored.
// "Start a document" moves the body into a new document's notes and deletes
// the note, so it then shows only as that document's notes (no duplicate).
//
// Team-scoped like documents (requireTeam documentRead / documentWrite). No
// model calls, so no rate-limit family. Client-safe: zod and plain types only.
//
// CONTRACT (redesign 3 foundation): implemented by the notes track
// (src/lib/notes/store.ts, src/app/api/notes/**).

import { z } from "zod";
import { MAX_DOCUMENT_NOTES } from "@/lib/documents/notes-contract";

/** Longest note body (the same cap as a document's notes, so a note always fits when it becomes one). */
export const MAX_NOTE_BODY = MAX_DOCUMENT_NOTES;
/** Longest derived title (characters). */
export const NOTE_TITLE_MAX = 120;
/** Most items GET /api/notes returns. */
export const NOTES_FEED_LIMIT = 200;
/** Excerpt length on a Notes card (characters, after the title line). */
export const NOTE_EXCERPT_MAX = 160;

/** A standalone note as the API returns it. */
export type Note = {
  id: string;
  body: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

/** The first non-empty line, trimmed and capped; "" when the body is blank (the UI shows "Untitled note"). */
export function noteTitle(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > NOTE_TITLE_MAX ? `${line.slice(0, NOTE_TITLE_MAX - 1).trimEnd()}…` : line;
}

/** The text after the title line, whitespace collapsed, capped for a card. */
export function noteExcerpt(body: string): string {
  const lines = body.split("\n");
  const first = lines.findIndex((l) => l.trim().length > 0);
  const rest = first < 0 ? "" : lines.slice(first + 1).join(" ").replace(/\s+/g, " ").trim();
  return rest.length > NOTE_EXCERPT_MAX ? `${rest.slice(0, NOTE_EXCERPT_MAX - 1).trimEnd()}…` : rest;
}

// --- GET /api/notes?q= ---------------------------------------------------------
// Every notes item of the team, newest `updated_at` first, at most
// NOTES_FEED_LIMIT: standalone notes, and each non-archived document whose
// `notes` is not blank. `q` matches a note's body, a document's notes or its
// title (case-insensitive). A document item's `updated_at` is the document's.
export type NotesFeedItem =
  | { kind: "note"; id: string; title: string; excerpt: string; updated_at: string; created_by: string }
  | {
      kind: "document";
      document_id: string;
      document_title: string;
      type_key: string | null;
      /** noteTitle(document.notes). */
      title: string;
      excerpt: string;
      updated_at: string;
    };
export type NotesFeedResponse = { items: NotesFeedItem[] };

// --- POST /api/notes -------------------------------------------------------------
// 201 with the note. The Notes tab's New card posts an empty body and opens it.
export const CreateNoteBody = z.object({ body: z.string().max(MAX_NOTE_BODY).default("") });
export type CreateNoteBody = z.input<typeof CreateNoteBody>;
export type NoteResponse = { note: Note };

// --- GET /api/notes/[id] -----------------------------------------------------------
// 200 NoteResponse; 404 { error } for an unknown id or another team's note.

// --- PATCH /api/notes/[id] ---------------------------------------------------------
// Optimistic concurrency like documents: `base_updated_at` is the updated_at
// the client last saw. A stale base answers 409 NoteConflictResponse.
export const UpdateNoteBody = z.object({
  body: z.string().max(MAX_NOTE_BODY),
  base_updated_at: z.string().min(1).optional(),
});
export type UpdateNoteBody = z.infer<typeof UpdateNoteBody>;
export type NoteConflictResponse = { error: string; code: "conflict"; note: Note };

// --- DELETE /api/notes/[id] --------------------------------------------------------
export type DeleteNoteResponse = { deleted: true };

// --- POST /api/notes/[id]/start-document ---------------------------------------------
// Creates an untyped document whose `notes` is the note's body and whose title
// is noteTitle(body), deletes the note, and answers 201 with the new document's
// id. The client then opens /d/<id>?notes=1. Needs documentWrite.
export type StartDocumentResponse = { document: { id: string; title: string } };
