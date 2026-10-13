import { describe, expect, it } from "vitest";
import { cardSubtitle, leadText, NEW_DOCUMENT_PATH, OPEN_NOTES_PARAM, OPEN_RUN_PARAM } from "./card-text";

describe("cardSubtitle", () => {
  it("is the first line of the body", () => {
    expect(cardSubtitle("Japan trip", "14 days in Tokyo, Kyoto, and more\nDay 1")).toBe("14 days in Tokyo, Kyoto, and more");
  });
  it("skips blank lines and a line repeating the title (any case)", () => {
    expect(cardSubtitle("Daily Habits", "\n  daily habits \n\nBrainstorm outcomes")).toBe("Brainstorm outcomes");
  });
  it("trims the line it returns", () => {
    expect(cardSubtitle("", "   Listing app  ")).toBe("Listing app");
  });
  it("is empty when there is nothing else", () => {
    expect(cardSubtitle("Plan", "")).toBe("");
    expect(cardSubtitle("Plan", "Plan\n \n")).toBe("");
  });
});

describe("leadText", () => {
  const h = (t: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: t }] });
  const p = (...t: string[]) => ({ type: "paragraph", content: t.map((text) => ({ type: "text", text })) });
  it("skips headings and empty paragraphs to the first text block", () => {
    expect(leadText({ type: "doc", content: [h("Summary"), { type: "paragraph" }, p("Riverside ", "proposes"), p("second")] })).toBe("Riverside proposes");
  });
  it("takes the first item of a list, not the whole list", () => {
    const list = { type: "bulletList", content: [{ type: "listItem", content: [p("one")] }, { type: "listItem", content: [p("two")] }] };
    expect(leadText({ type: "doc", content: [h("Goals"), list] })).toBe("one");
  });
  it("skips non-text inline nodes and cuts to 200 characters", () => {
    expect(leadText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] })).toBe("ab");
    expect(leadText({ type: "doc", content: [p("x".repeat(300))] })).toHaveLength(200);
  });
  it("is empty for a document of headings only, or none", () => {
    expect(leadText({ type: "doc", content: [h("Only")] })).toBe("");
    expect(leadText(null)).toBe("");
  });
  it("is what cardSubtitle prefers over the excerpt", () => {
    expect(cardSubtitle("Plan", "Summary\nRiverside proposes", "Riverside proposes")).toBe("Riverside proposes");
    expect(cardSubtitle("Plan", "Summary", "  ")).toBe("Summary");
  });
});

describe("card links", () => {
  it("names the deep-link parameters and the new-document route", () => {
    expect(OPEN_NOTES_PARAM).toBe("notes");
    expect(OPEN_RUN_PARAM).toBe("run");
    expect(NEW_DOCUMENT_PATH).toBe("/new");
  });
});
