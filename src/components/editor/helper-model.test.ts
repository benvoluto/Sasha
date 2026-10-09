import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import { documentExtensions } from "./extensions";
import { firstParagraphWritten, hasHeadings, hasText, helperDismissedKey, helperVisible, readHelperDismissed, shouldDismiss, writeHelperDismissed } from "./helper-model";

const schema = getSchema(documentExtensions());
const p = (text = "") => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) });
const h = (text: string) => ({ type: "heading", attrs: { level: 2, sectionId: "s_1", specKey: null }, content: [{ type: "text", text }] });
const doc = (...content: object[]) => PMNodeClass.fromJSON(schema, { type: "doc", content });
/** A caret at `pos`. */
const at = (pos: number) => ({ from: pos, to: pos });

describe("firstParagraphWritten", () => {
  it("is false on an empty document and while typing in the first paragraph", () => {
    expect(firstParagraphWritten(doc(p()), at(1))).toBe(false);
    expect(firstParagraphWritten(doc(p("Dear board")), at(5))).toBe(false);
    expect(firstParagraphWritten(doc(p("Dear board")), at(11))).toBe(false);
    expect(firstParagraphWritten(doc(p("Dear board")), null)).toBe(false);
  });

  it("is true once Enter starts another block after the text", () => {
    expect(firstParagraphWritten(doc(p("Dear board"), p()), at(13))).toBe(true);
    expect(firstParagraphWritten(doc(p(), p("Dear board"), p()), at(1))).toBe(true);
  });

  it("is true when the only text block has text and the selection has left it", () => {
    // An empty paragraph first, then the text: the caret back in the empty one.
    expect(firstParagraphWritten(doc(p(), p("Dear board")), at(1))).toBe(true);
    expect(firstParagraphWritten(doc(p(), p("Dear board")), at(5))).toBe(false);
  });

  it("ignores whitespace-only blocks", () => {
    expect(firstParagraphWritten(doc(p("   "), p()), at(1))).toBe(false);
  });
});

describe("hasText", () => {
  it("is false on an empty or whitespace-only document and true once any block has text", () => {
    expect(hasText(doc(p()))).toBe(false);
    expect(hasText(doc(p("  "), p()))).toBe(false);
    expect(hasText(doc(p(), p("Dear board")))).toBe(true);
    expect(hasText(doc(h("Summary")))).toBe(true);
  });

  it("keeps the helper off a loaded one-paragraph document whose caret starts inside it", () => {
    // The editor opens a saved document with the caret at Selection.atStart (pos 1), inside its only paragraph.
    const loaded = doc(p("An existing paragraph of text."));
    expect(helperVisible({ dismissed: false, typeKey: null, doc: loaded, selection: at(1), tellMePhase: "idle" })).toBe(true);
    // EmptyHelper starts dismissed when the document opened with text.
    expect(helperVisible({ dismissed: hasText(loaded), typeKey: null, doc: loaded, selection: at(1), tellMePhase: "idle" })).toBe(false);
  });
});

describe("helperVisible", () => {
  const base = { dismissed: false, typeKey: null, doc: doc(p()), selection: at(1), tellMePhase: "idle" as const };
  it("shows on an untyped, empty, undismissed document", () => {
    expect(helperVisible(base)).toBe(true);
    expect(helperVisible({ ...base, doc: doc(p("Typing")), selection: at(3) })).toBe(true);
  });
  it("hides when dismissed, typed, outlined or written", () => {
    expect(helperVisible({ ...base, dismissed: true })).toBe(false);
    expect(helperVisible({ ...base, typeKey: "memo" })).toBe(false);
    expect(helperVisible({ ...base, doc: doc(h("Summary"), p()) })).toBe(false);
    expect(helperVisible({ ...base, doc: doc(p("Done"), p()) })).toBe(false);
  });
  it("always shows while tell me is running or reporting", () => {
    for (const phase of ["choosing", "needs_type", "drafting", "done", "failed"] as const) {
      expect(helperVisible({ ...base, dismissed: true, typeKey: "memo", doc: doc(h("Summary"), p("x")), tellMePhase: phase })).toBe(true);
    }
  });
});

describe("shouldDismiss", () => {
  const base = { typeKey: null, doc: doc(p()), selection: at(1), tellMePhase: "idle" as const };
  it("dismisses once the document is written, outlined or typed, never mid-run", () => {
    expect(shouldDismiss(base)).toBe(false);
    expect(shouldDismiss({ ...base, doc: doc(p("Hi"), p()) })).toBe(true);
    expect(shouldDismiss({ ...base, doc: doc(h("Summary"), p()) })).toBe(true);
    expect(shouldDismiss({ ...base, typeKey: "memo" })).toBe(true);
    expect(shouldDismiss({ ...base, typeKey: "memo", tellMePhase: "drafting" })).toBe(false);
  });
});

describe("hasHeadings", () => {
  it("finds a top-level heading", () => {
    expect(hasHeadings(doc(p("x")))).toBe(false);
    expect(hasHeadings(doc(p("x"), h("A")))).toBe(true);
  });
});

describe("helper dismissal storage", () => {
  function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k) => m.get(k) ?? null,
      key: (i) => [...m.keys()][i] ?? null,
      removeItem: (k) => void m.delete(k),
      setItem: (k, v) => void m.set(k, v),
    };
  }

  it("keeps the flag per document under sasha.helper.dismissed.<id>", () => {
    const s = memoryStorage();
    expect(readHelperDismissed("d1", s)).toBe(false);
    writeHelperDismissed("d1", s);
    expect(s.getItem(helperDismissedKey("d1"))).toBe("1");
    expect(helperDismissedKey("d1")).toBe("sasha.helper.dismissed.d1");
    expect(readHelperDismissed("d1", s)).toBe(true);
    expect(readHelperDismissed("d2", s)).toBe(false);
  });

  it("survives storage that is missing or throws", () => {
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(readHelperDismissed("d1", throwing)).toBe(false);
    expect(() => writeHelperDismissed("d1", throwing)).not.toThrow();
    expect(readHelperDismissed("d1", null)).toBe(false);
  });
});
