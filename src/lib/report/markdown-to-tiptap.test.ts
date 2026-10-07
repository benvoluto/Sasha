import { describe, expect, it } from "vitest";
import { markdownToTiptap, tiptapToHtml, tiptapToText } from "./markdown-to-tiptap";

describe("markdownToTiptap", () => {
  it("parses headings, paragraphs and marks", () => {
    const doc = markdownToTiptap("## Title\n\nSome **bold** and *italic* text.");
    expect(doc.content[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(doc.content[1].type).toBe("paragraph");
    const marks = (doc.content[1].content ?? []).flatMap((n) => (n.marks ?? []).map((m) => m.type));
    expect(marks).toEqual(expect.arrayContaining(["bold", "italic"]));
  });

  it("parses bullet and ordered lists", () => {
    expect(markdownToTiptap("- one\n- two").content[0].type).toBe("bulletList");
    expect(markdownToTiptap("1. one\n2. two").content[0].type).toBe("orderedList");
  });

  it("parses a GFM pipe table into real table nodes", () => {
    const doc = markdownToTiptap("| Metric | Value |\n| --- | --- |\n| Revenue | 108 |");
    const table = doc.content.find((n) => n.type === "table");
    expect(table).toBeTruthy();
    expect(table!.content).toHaveLength(2); // header + one row
    expect(table!.content![0].content![0].type).toBe("tableHeader");
    expect(table!.content![1].content![0].type).toBe("tableCell");
  });

  it("does not swallow a table that follows a paragraph without a blank line", () => {
    const doc = markdownToTiptap("Intro sentence.\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph", "table"]);
  });

  it("never returns an empty doc", () => {
    expect(markdownToTiptap("").content).toHaveLength(1);
  });
});

describe("tiptapToHtml", () => {
  it("round-trips markdown through ProseMirror to HTML", () => {
    const html = tiptapToHtml(markdownToTiptap("## Title\n\nSome **bold** text."));
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders lists and tables", () => {
    expect(tiptapToHtml(markdownToTiptap("- one\n- two"))).toContain("<ul><li><p>one</p></li>");
    const table = tiptapToHtml(markdownToTiptap("| A |\n| --- |\n| 1 |"));
    expect(table).toContain("<table>");
    expect(table).toContain("<th>");
    expect(table).toContain("<td>");
  });

  it("renders the baked distribution-curve image node", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [{ type: "image", attrs: { src: "data:image/svg+xml,%3Csvg%3E", alt: "curve" } }],
    });
    expect(html).toBe('<img src="data:image/svg+xml,%3Csvg%3E" alt="curve">');
  });

  it("escapes HTML in text so stored content can't inject markup", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: '<script>alert("x")</script>' }] }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps children of an unknown node rather than dropping them", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [{ type: "somethingNew", content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }] }],
    });
    expect(html).toContain("kept");
  });

  it("returns empty string for an empty/missing doc", () => {
    expect(tiptapToHtml(null)).toBe("");
    expect(tiptapToHtml({ type: "doc", content: [] })).toBe("");
  });
});

describe("tiptapToText", () => {
  it("flattens a doc to plain text", () => {
    expect(tiptapToText(markdownToTiptap("## Title\n\nBody text."))).toContain("Body text.");
  });
});
