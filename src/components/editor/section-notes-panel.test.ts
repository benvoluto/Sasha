import { describe, expect, it } from "vitest";
import { dictationEnded, dictationSave, joinDictation } from "./section-notes-panel";

describe("joinDictation", () => {
  it("adds the dictated text after the notes with one separator", () => {
    expect(joinDictation("", "hello")).toBe("hello");
    expect(joinDictation("Points:", "hello")).toBe("Points: hello");
    expect(joinDictation("Points:\n", "hello")).toBe("Points:\nhello");
    expect(joinDictation("Points:", "")).toBe("Points:");
  });
});

describe("dictationSave", () => {
  it("saves to the section the dictation started in, with that section's notes", () => {
    // Started in A; the caret has since moved to B, whose notes are on screen now.
    const started = { sectionId: "s_aaaaaaaa", specKey: "summary", base: "A's notes" };
    expect(dictationSave(started, "more about A")).toEqual({ sectionId: "s_aaaaaaaa", specKey: "summary", notes: "A's notes more about A" });
  });
});

describe("dictationEnded", () => {
  it("is true only when recognition stopped by itself with a dictation open", () => {
    expect(dictationEnded(true, false, true)).toBe(true);
    // Finish and Cancel close the dictation before recognition reports the stop.
    expect(dictationEnded(true, false, false)).toBe(false);
    // Started, but recognition hasn't reported listening yet.
    expect(dictationEnded(false, false, true)).toBe(false);
    expect(dictationEnded(true, true, true)).toBe(false);
  });
});
