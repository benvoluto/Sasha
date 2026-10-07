import { describe, expect, it } from "vitest";
import { isArchived, resolveNote, type SummaryNote } from "./case-flags";

const note = (over: Partial<SummaryNote> = {}): SummaryNote => ({
  text: "Draft looks solid. Next steps: add the budget table.",
  editedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("resolveNote", () => {
  it("shows the generated summary when nobody has edited it", () => {
    expect(resolveNote(undefined, "Generated summary")).toEqual({ text: "Generated summary", edited: false, stale: false });
  });

  it("is empty rather than undefined when there is nothing to show", () => {
    expect(resolveNote(undefined, undefined)).toEqual({ text: "", edited: false, stale: false });
  });

  // The whole point of the note: what the person wrote is what shows.
  it("prefers the person's note over the generated summary", () => {
    const r = resolveNote(note(), "Something the pipeline produced later");
    expect(r.text).toContain("Draft looks solid");
    expect(r.edited).toBe(true);
  });

  it("flags the note as stale when the document has moved on since the edit", () => {
    const r = resolveNote(note({ basedOn: "old generated text" }), "new generated text");
    expect(r.stale).toBe(true);
    expect(r.text).toContain("Draft looks solid"); // still theirs — stale, not replaced
  });

  it("is not stale when the generated summary is unchanged", () => {
    expect(resolveNote(note({ basedOn: "same text" }), "same text").stale).toBe(false);
  });

  it("ignores whitespace-only differences when deciding staleness", () => {
    expect(resolveNote(note({ basedOn: "  same text  " }), "same text").stale).toBe(false);
  });

  // An edit made before basedOn was recorded shouldn't nag on every load.
  it("does not claim staleness without a recorded basis", () => {
    expect(resolveNote(note(), "anything at all").stale).toBe(false);
  });

  it("treats an empty note as no note", () => {
    expect(resolveNote(note({ text: "" }), "Generated").edited).toBe(false);
  });
});

describe("isArchived", () => {
  it("reads the archive record", () => {
    expect(isArchived({ archived: { at: "2026-01-01T00:00:00.000Z" } })).toBe(true);
    expect(isArchived({})).toBe(false);
    expect(isArchived(null)).toBe(false);
    expect(isArchived(undefined)).toBe(false);
  });
});
