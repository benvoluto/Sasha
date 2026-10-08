import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_NOTES } from "@/lib/documents/notes-contract";
import { capNotes, notesCount, notesSaveText } from "./notes-pane";

describe("notesSaveText", () => {
  it("follows the document's save status", () => {
    expect(notesSaveText("idle", null)).toBe("");
    expect(notesSaveText("saving", null)).toBe("Saving…");
    expect(notesSaveText("saved", null)).toBe("Saved");
    expect(notesSaveText("error", "Save failed (500).")).toBe("Save failed (500).");
    expect(notesSaveText("error", null)).toBe("Not saved");
    expect(notesSaveText("conflict", "ignored")).toBe("Not saved");
  });
});

describe("notesCount", () => {
  it("appears only within 10% of the cap", () => {
    expect(notesCount(0)).toBeNull();
    expect(notesCount(MAX_DOCUMENT_NOTES * 0.9 - 1)).toBeNull();
    expect(notesCount(MAX_DOCUMENT_NOTES * 0.9)).toBe("180,000 / 200,000 characters");
    expect(notesCount(MAX_DOCUMENT_NOTES)).toBe("200,000 / 200,000 characters");
    expect(notesCount(95, 100)).toBe("95 / 100 characters");
  });
});

describe("capNotes", () => {
  it("cuts notes (a long dictation) at the cap", () => {
    expect(capNotes("abc", 5)).toBe("abc");
    expect(capNotes("abcdefg", 5)).toBe("abcde");
    expect(capNotes("x".repeat(MAX_DOCUMENT_NOTES + 10))).toHaveLength(MAX_DOCUMENT_NOTES);
  });
});
