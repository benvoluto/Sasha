// The Notes tab's feed (GET /api/notes): standalone notes and documents'
// notes in one list, newest `updated_at` first, capped at NOTES_FEED_LIMIT.

import type { DocumentNotesSummary } from "@/lib/documents/store";
import { NOTES_FEED_LIMIT, noteExcerpt, noteTitle, type Note, type NotesFeedItem } from "./contract";

export function notesFeed(notes: Note[], documents: DocumentNotesSummary[], limit = NOTES_FEED_LIMIT): NotesFeedItem[] {
  const items: NotesFeedItem[] = [
    ...notes.map((n): NotesFeedItem => ({
      kind: "note",
      id: n.id,
      title: noteTitle(n.body),
      excerpt: noteExcerpt(n.body),
      updated_at: n.updated_at,
      created_by: n.created_by,
    })),
    ...documents.map((d): NotesFeedItem => ({
      kind: "document",
      document_id: d.id,
      document_title: d.title,
      type_key: d.type_key,
      title: noteTitle(d.notes),
      excerpt: noteExcerpt(d.notes),
      updated_at: d.updated_at,
    })),
  ];
  // ISO strings in UTC sort as times.
  return items.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
}
