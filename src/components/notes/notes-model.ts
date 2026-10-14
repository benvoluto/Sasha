// Pure rules behind the Notes tab and the note dialog (redesign3-spec.md §7).

import { noteExcerpt, noteTitle, type Note, type NotesFeedItem } from "@/lib/notes/contract";

/** A standalone note card's accessible name (and its visible title). */
export function noteCardName(title: string): string {
  return title.trim() || "Untitled note";
}

/** A document notes card's accessible name: "<doc title|Untitled> notes". */
export function documentNotesName(documentTitle: string): string {
  return `${documentTitle.trim() || "Untitled"} notes`;
}

/** A note closed with nothing in it is deleted, so no empty cards pile up. */
export function isBlankNote(body: string): boolean {
  return body.trim() === "";
}

/** The feed item for a note as just saved. */
export function noteFeedItem(note: Note): NotesFeedItem {
  return { kind: "note", id: note.id, title: noteTitle(note.body), excerpt: noteExcerpt(note.body), updated_at: note.updated_at, created_by: note.created_by };
}

/** The feed with `note` added or replaced, newest first (a save shows on its card before the next fetch). */
export function upsertNote(items: NotesFeedItem[], note: Note): NotesFeedItem[] {
  const rest = items.filter((i) => !(i.kind === "note" && i.id === note.id));
  return [noteFeedItem(note), ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** The feed without the note `id` (deleted, or turned into a document). */
export function removeNote(items: NotesFeedItem[], id: string): NotesFeedItem[] {
  return items.filter((i) => !(i.kind === "note" && i.id === id));
}

/** What a failed save tells the person, from the status and the server's { error }. */
export function noteSaveError(status: number, message?: string | null): string {
  if (status === 404) return "This note was deleted.";
  if (status === 401) return "Sign in again to save.";
  return message || `Not saved (${status}).`;
}
