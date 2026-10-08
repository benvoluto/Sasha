import { describe, expect, it } from "vitest";
import { dictationSave } from "./section-notes-panel";

// joinDictation and dictationEnded moved to dictation-field.tsx (tested in dictation-field.test.ts).

describe("dictationSave", () => {
  it("saves to the section the dictation started in, with that section's notes", () => {
    // Started in A; the caret has since moved to B, whose notes are on screen now.
    const started = { sectionId: "s_aaaaaaaa", specKey: "summary", base: "A's notes" };
    expect(dictationSave(started, "more about A")).toEqual({ sectionId: "s_aaaaaaaa", specKey: "summary", notes: "A's notes more about A" });
  });
});
