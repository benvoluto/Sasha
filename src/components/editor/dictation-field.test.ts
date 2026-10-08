import { describe, expect, it } from "vitest";
import { dictationEnded, dictationError, dictationReducer, joinDictation, type Dictation } from "./dictation-field";

describe("joinDictation", () => {
  it("adds the dictated text after the notes with one separator", () => {
    expect(joinDictation("", "hello")).toBe("hello");
    expect(joinDictation("Points:", "hello")).toBe("Points: hello");
    expect(joinDictation("Points:\n", "hello")).toBe("Points:\nhello");
    expect(joinDictation("Points:", "")).toBe("Points:");
    expect(joinDictation("", "")).toBe("");
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

describe("dictationError", () => {
  it("explains permanent errors and names the others", () => {
    expect(dictationError("not-allowed")).toMatch(/Microphone blocked/);
    expect(dictationError("service-not-allowed")).toMatch(/Microphone blocked/);
    expect(dictationError("audio-capture")).toBe("No microphone was found.");
    expect(dictationError("network")).toMatch(/internet connection/);
    expect(dictationError("bad-grammar")).toBe("Dictation stopped (bad-grammar).");
  });
});

describe("dictationReducer", () => {
  const open: Dictation = { base: "Who it's for:", caret: 13 };

  it("start remembers the notes and the caret, and a second start keeps the first", () => {
    expect(dictationReducer(null, { type: "start", base: "Who it's for:", caret: 13 })).toEqual({ state: open, commit: null, restore: null });
    expect(dictationReducer(open, { type: "start", base: "other" }).state).toBe(open);
    expect(dictationReducer(null, { type: "start", base: "" }).state).toEqual({ base: "", caret: null });
  });

  it("commit (Finish, an unexpected end, closing) saves base + transcript once", () => {
    const first = dictationReducer(open, { type: "commit", said: "the board" });
    expect(first).toEqual({ state: null, commit: "Who it's for: the board", restore: null });
    // The end-of-recognition effect after Finish finds nothing open: no second save.
    expect(dictationReducer(first.state, { type: "commit", said: "the board" })).toEqual({ state: null, commit: null, restore: null });
  });

  it("commit with nothing said keeps the notes as they were", () => {
    expect(dictationReducer(open, { type: "commit", said: "" }).commit).toBe("Who it's for:");
  });

  it("cancel discards the transcript and puts the notes back", () => {
    expect(dictationReducer(open, { type: "cancel" })).toEqual({ state: null, commit: null, restore: "Who it's for:" });
    expect(dictationReducer(null, { type: "cancel" })).toEqual({ state: null, commit: null, restore: null });
  });
});
