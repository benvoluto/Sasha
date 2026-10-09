import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import { markdownToTiptap } from "@/lib/report/markdown-to-tiptap";
import { exportCitations, type ExportImages, type ExportInput } from "./contract";
import { decodeDataImage, imageSources, toExportImage } from "./images";
import { MAX_MARKDOWN_DATA_URI, tiptapToMarkdown } from "./markdown";

const FIXTURES = path.join(__dirname, "__fixtures__");
// SASHA_UPDATE_GOLDEN=1 rewrites the golden file after a deliberate change.
const golden = (name: string, actual: string) => {
  const file = path.join(FIXTURES, name);
  if (process.env.SASHA_UPDATE_GOLDEN === "1") writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
};

/** The sample fixture as the route would hand it to a writer (images decoded without the store). */
function sampleInput(): ExportInput {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, "sample.json"), "utf8")) as {
    title: string;
    typeTitle: string;
    typeKey: string;
    origin: string;
    doc: PMNode;
    references: ResolvedReference[];
  };
  const { doc, numberOf } = exportCitations(raw.doc);
  const images: ExportImages = new Map(
    imageSources(doc).map((src) => {
      const d = decodeDataImage(src);
      return [src, d ? toExportImage(d.mime, d.data) : null];
    }),
  );
  return { doc, title: raw.title, typeTitle: raw.typeTitle, typeKey: raw.typeKey, references: raw.references, numberOf, origin: raw.origin, images };
}

const p = (...content: PMNode[]): PMNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]): PMNode => (marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text });
const md = (doc: PMNode, extra: Partial<ExportInput> = {}) => tiptapToMarkdown(doc, { numberOf: new Map(), references: [], origin: "https://sasha.app", ...extra });

describe("tiptapToMarkdown", () => {
  it("matches the golden sample (every node, nested lists, a table, images, links, citations of both kinds, a stale reference)", () => {
    const input = sampleInput();
    golden("sample.md", tiptapToMarkdown(input.doc, input));
  });

  it("numbers citations by first appearance and writes them in number order after the run", () => {
    const out = tiptapToMarkdown(sampleInput().doc, sampleInput());
    expect(out).toContain("Demand rose 12% in 2025.[\\[1\\]][1] Prices held steady.[\\[2\\]][2][\\[3\\]][3] Costs fell.[\\[1\\]][1]");
    expect(out).toContain("[Prices 2025](https://sasha.app/library?source=");
    expect(out).toMatch(/\[\\\[4\\\]\]\[4\]/);
    expect(out).toContain("[1]: https://sasha.app/library?source=1a2b3c4d-1111-4111-8111-111111111111&passage=S1a2b3c4d.P7 \"Q3 Industry Report, p. 4\"");
    expect(out).toContain('"Price watch \\"weekly\\""');
    expect(out).toContain("_Some references may be out of date: 3, the source was re-read");
  });

  it("keeps titles with newlines and HTML on one line: no raw HTML block, no injected heading", () => {
    const input = sampleInput();
    const evil = 'Evil"\n\n<img src=x onerror=alert(1)>\n\n# Owned';
    const references = input.references.map((r, i) => (i === 0 ? { ...r, sourceTitle: evil } : r));
    const out = tiptapToMarkdown(input.doc, { ...input, title: "Doc\n# Inj", references });
    const lines = out.split("\n");
    expect(lines.some((l) => /^\s*</.test(l))).toBe(false);
    expect(lines.some((l) => /^\s*#+ (Owned|Inj)/.test(l))).toBe(false);
    expect(out).not.toMatch(/(^|[^\\])<img/m);
    expect(lines[0]).toBe("# Doc # Inj");
    const def = lines.find((l) => l.startsWith("[1]: "));
    expect(def).toMatch(/ "Evil\\" \\<img src=x onerror=alert\(1\)\\> # Owned, p\. 4"$/);
    expect(lines.find((l) => l.startsWith("1. Evil"))).toContain("Evil\" \\<img src=x onerror=alert(1)\\> # Owned, p. 4");
  });

  it("nests marks without empty delimiters and keeps edge spaces outside them", () => {
    const doc = { type: "doc", content: [p(t("a "), t("bold ", "bold"), t("both", "bold", "italic"), t(" end"))] };
    expect(md(doc)).toBe("**bold _both_** end\n".replace(/^/, "a "));
  });

  it("escapes Markdown in text and block starts in paragraphs", () => {
    const doc = { type: "doc", content: [p(t("# hash")), p(t("1. one")), p(t("a*b_c [x] <y>"))] };
    expect(md(doc)).toBe("\\# hash\n\n1\\. one\n\na\\*b\\_c \\[x\\] \\<y\\>\n");
  });

  it("drops unsafe links to text and makes relative ones absolute", () => {
    const link = (href: string): PMNode => ({ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] });
    const doc = { type: "doc", content: [p(link("javascript:alert(1)"), t(" "), link("/d/1"), t(" "), link("data:text/html,hi"))] };
    expect(md(doc)).toBe("x [x](https://sasha.app/d/1) x\n");
  });

  it("writes code spans around backticks and fences code blocks longer than their content", () => {
    const doc = {
      type: "doc",
      content: [p(t("a`b", "code")), { type: "codeBlock", content: [t("```\nx")] }],
    };
    expect(md(doc)).toBe("``a`b``\n\n````\n```\nx\n````\n");
  });

  it("indents ordered children by the marker width", () => {
    const li = (...c: PMNode[]): PMNode => ({ type: "listItem", content: c });
    const items = Array.from({ length: 10 }, (_, i) => li(p(t(`i${i + 1}`))));
    items[9] = li(p(t("i10")), { type: "bulletList", content: [li(p(t("deep")))] });
    expect(md({ type: "doc", content: [{ type: "orderedList", content: items }] })).toContain("10. i10\n    - deep");
  });

  it("replaces images it may not embed, and data URIs over the size cap, with alt text", () => {
    const big = `data:image/png;base64,${"A".repeat(MAX_MARKDOWN_DATA_URI)}`;
    const images: ExportImages = new Map([[big, { mime: "image/png", data: new Uint8Array(1), dataUri: big, width: 1, height: 1 }]]);
    const doc = { type: "doc", content: [{ type: "image", attrs: { src: big, alt: "Big" } }, { type: "image", attrs: { src: "https://x.example/a.png", alt: "Far" } }] };
    expect(md(doc, { images })).toBe("\\[Image: Big\\]\n\n\\[Image: Far\\]\n");
  });

  it("escapes pipes and keeps line breaks in table cells", () => {
    const cell = (type: string, ...c: PMNode[]): PMNode => ({ type, content: [p(...c)] });
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("tableHeader", t("A")), cell("tableHeader", t("B"))] },
            { type: "tableRow", content: [cell("tableCell", t("x|y")), cell("tableCell", t("1"), { type: "hardBreak" }, t("2"))] },
          ],
        },
      ],
    };
    expect(md(doc)).toBe("| A | B |\n| --- | --- |\n| x\\|y | 1<br>2 |\n");
  });
});

describe("round trip through markdownToTiptap", () => {
  // The subset markdownToTiptap reads: headings, paragraphs, flat lists, bold, italic, rules and tables.
  const subset = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [t("Overview")] },
      p(t("Plain, "), t("bold", "bold"), t(" and "), t("italic", "italic"), t(" with 5 * 3, a_b and [brackets] # inside.")),
      p(t("# Looks like a heading")),
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("one"))] }, { type: "listItem", content: [p(t("- two"))] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [p(t("first"))] }, { type: "listItem", content: [p(t("second"))] }] },
      { type: "horizontalRule" },
      {
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("Metric"))] }, { type: "tableHeader", content: [p(t("Value"))] }] },
          { type: "tableRow", content: [{ type: "tableCell", content: [p(t("Revenue"))] }, { type: "tableCell", content: [p(t("1|08"))] }] },
        ],
      },
    ],
  } satisfies PMNode;

  it("gives back the same document", () => {
    const back = markdownToTiptap(md(subset));
    expect(back).toEqual(subset);
  });
});
