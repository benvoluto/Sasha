import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { documentExtensions } from "./extensions";
import { sectionBodyRange } from "./tracked-range";
import { CITE_SOURCES_INSTRUCTION } from "@/lib/citations/contract";
import { applyDecision, bodyWithMarkers, busyAnnouncement, droppedNotice, generationError, isCiteSources, preflightError } from "./use-section-generation";

describe("applyDecision", () => {
  it("applies a draft when the body is still empty", () => {
    expect(applyDecision("", { bodyText: "" })).toBe("apply");
    expect(applyDecision("", { bodyText: "  \n" })).toBe("apply");
  });

  it("applies a rewrite when the body reads as it did", () => {
    expect(applyDecision("Some text.", { bodyText: "Some text.\n" })).toBe("apply");
  });

  it("asks first when the section changed while Claude was writing", () => {
    expect(applyDecision("", { bodyText: "I started writing" })).toBe("changed");
    expect(applyDecision("Some text.", { bodyText: "Some other text." })).toBe("changed");
  });

  it("gives up when the section was deleted", () => {
    expect(applyDecision("Some text.", null)).toBe("deleted");
  });
});

describe("generationError", () => {
  it("prefers the server's message", () => {
    expect(generationError(409, { error: "This section is fixed text; edit it directly." })).toBe("This section is fixed text; edit it directly.");
    const limited = "You've used your 30 drafts for this hour. Try again in 12 min.";
    expect(generationError(429, { error: limited, code: "rate_limited" } as { error: string })).toBe(limited);
  });
  it("explains common statuses without one", () => {
    expect(generationError(503, {})).toBe("Claude is not configured.");
    expect(generationError(404, {})).toMatch(/isn't available/);
    expect(generationError(500, {})).toMatch(/500/);
  });
});

describe("preflightError", () => {
  const section = { heading: "Background", bodyText: "Some text." };
  it("lets a run start when the section is ready", () => {
    expect(preflightError(section, "draft", false)).toBeNull();
    expect(preflightError(section, "rewrite", false)).toBeNull();
  });
  it("explains why a run can't start", () => {
    expect(preflightError(section, "draft", true)).toMatch(/already writing/);
    expect(preflightError(null, "draft", false)).toMatch(/no longer exists/);
    expect(preflightError({ heading: "  ", bodyText: "" }, "draft", false)).toMatch(/heading first/);
    expect(preflightError({ heading: "Background", bodyText: " \n" }, "rewrite", false)).toMatch(/Nothing to rewrite/);
  });
});

describe("busyAnnouncement", () => {
  it("names the section being written, or counts them", () => {
    expect(busyAnnouncement([])).toBe("");
    expect(busyAnnouncement(["Background"])).toBe("Claude is writing “Background”.");
    expect(busyAnnouncement([""])).toBe("Claude is writing “Untitled section”.");
    expect(busyAnnouncement(["A", "B"])).toBe("Claude is writing 2 sections.");
  });
});

describe("droppedNotice", () => {
  const d = (n: number) => ({ dropped: Array.from({ length: n }, () => ({ raw: "[[p:x]]", passageId: "x", reason: "malformed" as const })) });
  it("says how many citations were left out, or nothing", () => {
    expect(droppedNotice(null)).toBe("");
    expect(droppedNotice(d(0))).toBe("");
    expect(droppedNotice(d(1))).toBe("1 citation couldn't be checked against the sources and was left out.");
    expect(droppedNotice(d(2))).toBe("2 citations couldn't be checked against the sources and were left out.");
  });
});

describe("bodyWithMarkers", () => {
  it("sends a section body with its passage citations as bare markers, and the plain text compares as before", () => {
    const schema = getSchema(documentExtensions());
    const cite = { type: "citation", attrs: { kind: "passage", passageId: "S1a2b3c4d.P1", sourceId: "src", dataTableId: null, quote: "x", verified: true } };
    const doc = PMNodeClass.fromJSON(schema, {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2, sectionId: "s_a" }, content: [{ type: "text", text: "Findings" }] },
        { type: "paragraph", content: [{ type: "text", text: "Demand rose.", marks: [cite] }, { type: "text", text: " Prices held." }] },
        { type: "heading", attrs: { level: 2, sectionId: "s_b" }, content: [{ type: "text", text: "Next" }] },
      ],
    });
    const target = sectionBodyRange(doc, "s_a")!;
    expect(bodyWithMarkers({ state: EditorState.create({ schema, doc }) } as never, target)).toBe("Demand rose.[[p:S1a2b3c4d.P1]] Prices held.");
    expect(target.bodyText).toBe("Demand rose. Prices held.");
    expect(bodyWithMarkers({ state: EditorState.create({ schema, doc }) } as never, { from: 5, to: 5 })).toBe("");
  });
});

describe("isCiteSources", () => {
  it("is the section menu's rewrite with the constant instruction, and nothing else", () => {
    expect(isCiteSources({ mode: "rewrite", instruction: CITE_SOURCES_INSTRUCTION })).toBe(true);
    expect(isCiteSources({ mode: "rewrite", instruction: "Make it shorter." })).toBe(false);
    expect(isCiteSources({ mode: "rewrite_from_notes", instruction: CITE_SOURCES_INSTRUCTION })).toBe(false);
  });
});
