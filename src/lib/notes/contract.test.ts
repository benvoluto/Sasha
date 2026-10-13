import { describe, expect, it } from "vitest";
import { NOTE_EXCERPT_MAX, NOTE_TITLE_MAX, noteExcerpt, noteTitle } from "./contract";

describe("noteTitle", () => {
  it("is the first non-empty line, trimmed", () => {
    expect(noteTitle("Groceries\nmilk")).toBe("Groceries");
    expect(noteTitle("\n  \n  Plan for May  \nrest")).toBe("Plan for May");
    expect(noteTitle("")).toBe("");
    expect(noteTitle(" \n\t\n")).toBe("");
  });

  it("caps a long line with an ellipsis", () => {
    const t = noteTitle("a".repeat(NOTE_TITLE_MAX + 20));
    expect(t).toHaveLength(NOTE_TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(noteTitle("b".repeat(NOTE_TITLE_MAX))).toBe("b".repeat(NOTE_TITLE_MAX));
  });
});

describe("noteExcerpt", () => {
  it("is the text after the title line, whitespace collapsed", () => {
    expect(noteExcerpt("Title\nline one\n\n  line   two ")).toBe("line one line two");
    expect(noteExcerpt("\n\nTitle\nafter")).toBe("after");
    expect(noteExcerpt("Only a title")).toBe("");
    expect(noteExcerpt("")).toBe("");
  });

  it("caps a long excerpt with an ellipsis", () => {
    const e = noteExcerpt(`T\n${"word ".repeat(100)}`);
    expect(e.length).toBeLessThanOrEqual(NOTE_EXCERPT_MAX);
    expect(e.endsWith("…")).toBe(true);
  });
});
