import { describe, expect, it } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import { Transform } from "@tiptap/pm/transform";
import { mapRange, type TextRange } from "./tracked-range";

// <p>Hello brave world</p>: "brave" spans 7..12.
const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Hello brave world")])]);
const brave: TextRange = { from: 7, to: 12, text: "brave" };

describe("mapRange", () => {
  it("returns the range unchanged when nothing happened", () => {
    const tr = new Transform(doc);
    expect(mapRange(tr.mapping, tr.doc, brave)).toEqual({ from: 7, to: 12 });
  });

  it("follows the range when text is inserted before it, and keeps edge insertions outside", () => {
    const tr = new Transform(doc).insert(1, schema.text("Oh, ")).insert(16, schema.text("!"));
    // "Oh, Hello brave! world": brave moved by 4; the "!" typed at its end is not included.
    expect(mapRange(tr.mapping, tr.doc, brave)).toEqual({ from: 11, to: 16 });
  });

  it("gives up when the range was deleted", () => {
    const tr = new Transform(doc).delete(5, 14);
    expect(mapRange(tr.mapping, tr.doc, brave)).toBeNull();
  });

  it("gives up when the text inside the range changed", () => {
    const tr = new Transform(doc).insert(9, schema.text("XX"));
    expect(mapRange(tr.mapping, tr.doc, brave)).toBeNull();
  });
});
