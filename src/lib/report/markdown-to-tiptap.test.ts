import { describe, expect, it } from "vitest";
import { markdownToTiptap, safeLinkHref, tiptapToHtml, tiptapToText, type PMNode } from "./markdown-to-tiptap";

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

  it("reads backslash escapes as literal characters", () => {
    const doc = markdownToTiptap("\\# not a heading\n\n5 \\* 3 and a\\_b\\_c and \\[x\\]");
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
    expect(doc.content[0].content).toEqual([{ type: "text", text: "# not a heading" }]);
    expect(doc.content[1].content).toEqual([{ type: "text", text: "5 * 3 and a_b_c and [x]" }]);
    expect(markdownToTiptap("\\- item").content[0].type).toBe("paragraph");
    // A backslash before anything else stays.
    expect(markdownToTiptap("C:\\path").content[0].content).toEqual([{ type: "text", text: "C:\\path" }]);
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

  it("renders underline, highlight as <mark>, filled as plain text and a table header in <thead>", () => {
    const t = (text: string, type: string): PMNode => ({ type: "text", text, marks: [{ type }] });
    const html = tiptapToHtml({ type: "doc", content: [{ type: "paragraph", content: [t("u", "underline"), t("h", "highlight"), t("f", "filled")] }] });
    expect(html).toBe("<p><u>u</u><mark>h</mark>f</p>");
    const table = tiptapToHtml(markdownToTiptap("| A |\n| --- |\n| 1 |"));
    expect(table).toBe("<table><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>1</p></td></tr></tbody></table>");
  });

  it("follows each citation run with its numbers when given citationNumber, in number order", () => {
    const cite = (id: string) => ({ type: "citation", attrs: { kind: "passage", passageId: id } });
    const doc: PMNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "One ", marks: [cite("B")] },
            { type: "text", text: "two.", marks: [cite("B"), cite("A")] },
            { type: "text", text: " Three." },
          ],
        },
      ],
    };
    const numbers: Record<string, number> = { A: 1, B: 2 };
    const html = tiptapToHtml(doc, { citationNumber: (a) => numbers[String(a.passageId)] ?? null });
    expect(html).toBe(
      '<p><span class="citation">One </span><span class="citation">two.</span><sup class="cite"><a href="#ref-1">1</a></sup><sup class="cite"><a href="#ref-2">2</a></sup> Three.</p>',
    );
    // Without the option the text stays, with no numbers.
    expect(tiptapToHtml(doc)).not.toContain("<sup");
  });

  it("allows only safe links and images", () => {
    expect(safeLinkHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeLinkHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeLinkHref("#ref-1")).toBe("#ref-1");
    expect(safeLinkHref("/library?source=1")).toBe("/library?source=1");
    expect(safeLinkHref("/library", "https://sasha.app")).toBe("https://sasha.app/library");
    for (const bad of ["javascript:alert(1)", " JaVa\tScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "\\\\evil"]) expect(safeLinkHref(bad)).toBeNull();
    const img = (src: string) => tiptapToHtml({ type: "doc", content: [{ type: "image", attrs: { src, alt: "a" } }] });
    expect(img("javascript:alert(1)")).toBe('<span class="image-missing">[Image: a]</span>');
    expect(img("data:text/html,x")).toBe('<span class="image-missing">[Image: a]</span>');
    expect(img("https://cdn.example/a.png")).toBe('<img src="https://cdn.example/a.png" alt="a">');
    expect(tiptapToHtml({ type: "doc", content: [{ type: "image", attrs: { src: "https://cdn.example/a.png", alt: "a" } }] }, { imageSrc: () => null })).toContain("[Image: a]");
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
