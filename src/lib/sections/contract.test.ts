import { describe, expect, it } from "vitest";
import { notesActionMode, SectionGenerateRequest, SectionNotesPut } from "./contract";

const parse = (body: unknown) => SectionGenerateRequest.safeParse(body);

describe("SectionGenerateRequest", () => {
  it("accepts a draft with defaults", () => {
    const r = parse({ mode: "draft", heading: "Budget" });
    expect(r.success && r.data).toMatchObject({ level: 2, body: "" });
  });

  it("needs a body to rewrite and a preset or instruction for a plain rewrite", () => {
    expect(parse({ mode: "rewrite", heading: "Budget", body: "", preset: "concise" }).error?.issues[0]?.message).toMatch(/Nothing to rewrite/);
    expect(parse({ mode: "rewrite", heading: "Budget", body: "Text" }).error?.issues[0]?.message).toMatch(/preset or write an instruction/);
    expect(parse({ mode: "rewrite", heading: "Budget", body: "Text", instruction: "Shorter" }).success).toBe(true);
    expect(parse({ mode: "rewrite_from_notes", heading: "Budget", body: " " }).success).toBe(false);
    expect(parse({ mode: "rewrite_from_notes", heading: "Budget", body: "Text" }).success).toBe(true);
  });

  it("rejects unknown presets, unknown fields and blank headings", () => {
    expect(parse({ mode: "rewrite", heading: "B", body: "x", preset: "nope" }).success).toBe(false);
    expect(parse({ mode: "draft", heading: "B", extra: 1 }).success).toBe(false);
    expect(parse({ mode: "draft", heading: "  " }).success).toBe(false);
  });

  it("bounds notes", () => {
    expect(SectionNotesPut.safeParse({ notes: "x".repeat(50_001) }).success).toBe(false);
    expect(SectionNotesPut.safeParse({ notes: "ok", specKey: null }).success).toBe(true);
  });
});

describe("notesActionMode", () => {
  it("drafts from notes into an empty section, rewrites otherwise, and hides without notes", () => {
    expect(notesActionMode("", "facts")).toBe("draft_from_notes");
    expect(notesActionMode("Body", "facts")).toBe("rewrite_from_notes");
    expect(notesActionMode("Body", "  ")).toBeNull();
  });
});
