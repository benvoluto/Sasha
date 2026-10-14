import { describe, expect, it } from "vitest";
import type { Note, NotesFeedItem } from "@/lib/notes/contract";
import { documentNotesName, isBlankNote, noteCardName, noteSaveError, removeNote, upsertNote } from "./notes-model";

const note = (id: string, body: string, updated_at: string): Note => ({ id, body, created_by: "ann", updated_by: "ann", created_at: updated_at, updated_at });
const doc: NotesFeedItem = { kind: "document", document_id: "d1", document_title: "Grant", type_key: null, title: "Budget", excerpt: "", updated_at: "2026-01-02T00:00:00.000Z" };

describe("card names", () => {
  it("falls back to Untitled", () => {
    expect(noteCardName("Groceries")).toBe("Groceries");
    expect(noteCardName("  ")).toBe("Untitled note");
    expect(documentNotesName("Grant")).toBe("Grant notes");
    expect(documentNotesName("")).toBe("Untitled notes");
  });
});

describe("isBlankNote", () => {
  it("is true only for whitespace", () => {
    expect(isBlankNote("")).toBe(true);
    expect(isBlankNote(" \n\t")).toBe(true);
    expect(isBlankNote(" a ")).toBe(false);
  });
});

describe("upsertNote / removeNote", () => {
  it("adds, replaces and sorts newest first, and removes only that note", () => {
    let items = upsertNote([doc], note("n1", "Old\nbody", "2026-01-01T00:00:00.000Z"));
    expect(items.map((i) => i.kind)).toEqual(["document", "note"]);
    items = upsertNote(items, note("n1", "New title\nmore", "2026-01-03T00:00:00.000Z"));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "note", id: "n1", title: "New title", excerpt: "more" });
    expect(removeNote(items, "n1")).toEqual([doc]);
    expect(removeNote(items, "d1")).toHaveLength(2);
  });
});

describe("noteSaveError", () => {
  it("names the common failures", () => {
    expect(noteSaveError(404)).toBe("This note was deleted.");
    expect(noteSaveError(401)).toBe("Sign in again to save.");
    expect(noteSaveError(400, "Invalid note.")).toBe("Invalid note.");
    expect(noteSaveError(500)).toBe("Not saved (500).");
  });
});
