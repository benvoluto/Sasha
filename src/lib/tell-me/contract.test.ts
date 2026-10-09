import { describe, expect, it } from "vitest";
import { draftableSections, notesWithPrompt, pickPromptType, StartFromPromptRequest, TELL_ME_MIN_CONFIDENCE, TELL_ME_PROMPT_MAX, tellMeInstruction } from "./contract";

describe("pickPromptType", () => {
  const c = (key: string, confidence: number) => ({ key, confidence, why: "" });
  it("takes the top candidate when it is confident enough", () => {
    expect(pickPromptType({ candidates: [c("memo", 0.8), c("report", 0.4)], freeform: false })).toBe("memo");
    expect(pickPromptType({ candidates: [c("memo", TELL_ME_MIN_CONFIDENCE)], freeform: false })).toBe("memo");
  });
  it("gives null for freeform, no candidates or a weak top", () => {
    expect(pickPromptType({ candidates: [c("memo", 0.9)], freeform: true })).toBeNull();
    expect(pickPromptType({ candidates: [], freeform: false })).toBeNull();
    expect(pickPromptType({ candidates: [c("memo", 0.34)], freeform: false })).toBeNull();
    expect(pickPromptType({ candidates: [c("memo", 0.5)], freeform: false }, 0.6)).toBeNull();
  });
});

describe("tellMeInstruction", () => {
  it("frames the prompt for one section and fits the generate route's 2000 cap", () => {
    expect(tellMeInstruction("  A report  ")).toBe("The person described the whole document like this; write this section's part of it: A report");
    expect(tellMeInstruction("x".repeat(TELL_ME_PROMPT_MAX)).length).toBeLessThanOrEqual(2000);
  });
});

describe("notesWithPrompt", () => {
  it("adds the prompt as its own paragraph after any notes", () => {
    expect(notesWithPrompt("", " A report ")).toBe("What I asked Sasha for: A report");
    expect(notesWithPrompt("  \n", "A report")).toBe("What I asked Sasha for: A report");
    expect(notesWithPrompt("Funder: Hartley\n\n", "A report")).toBe("Funder: Hartley\n\nWhat I asked Sasha for: A report");
  });
});

describe("draftableSections", () => {
  it("leaves out fixed (static) sections", () => {
    const sections = [{ key: "a", renderer: "static" as const }, { key: "b", renderer: "prose" as const }, { key: "c", renderer: undefined }];
    expect(draftableSections(sections as never[]).map((s: { key: string }) => s.key)).toEqual(["b", "c"]);
  });
});

describe("StartFromPromptRequest", () => {
  it("trims and bounds the prompt, and allows no other fields", () => {
    expect(StartFromPromptRequest.parse({ prompt: "  A memo  " })).toEqual({ prompt: "A memo" });
    expect(StartFromPromptRequest.safeParse({ prompt: " ab " }).success).toBe(false);
    expect(StartFromPromptRequest.safeParse({ prompt: "x".repeat(TELL_ME_PROMPT_MAX + 1) }).success).toBe(false);
    expect(StartFromPromptRequest.safeParse({ prompt: "A memo", typeKey: "memo" }).success).toBe(false);
  });
});
