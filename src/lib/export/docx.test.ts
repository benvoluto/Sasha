import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import { countCitationOccurrences, exportCitations, type ExportImages, type ExportInput } from "./contract";
import { docxImageSize, exportDocx, xmlSafe } from "./docx";
import { decodeDataImage, imageSources, toExportImage } from "./images";

function sampleInput(): ExportInput {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", "sample.json"), "utf8")) as {
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

async function unzip(input: ExportInput) {
  const zip = await JSZip.loadAsync(await exportDocx(input));
  const read = async (name: string) => (await zip.file(name)?.async("string")) ?? "";
  return {
    document: await read("word/document.xml"),
    footnotes: await read("word/footnotes.xml"),
    core: await read("docProps/core.xml"),
    rels: await read("word/_rels/document.xml.rels"),
    files: Object.keys(zip.files),
  };
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("exportDocx", () => {
  it("writes one footnote reference per citation occurrence, with the footnote texts", async () => {
    const input = sampleInput();
    const { document, footnotes } = await unzip(input);
    const occurrences = countCitationOccurrences(input.doc, input.numberOf);
    expect(occurrences).toBe(5); // [1], [2][3], [1] again, and the table's [4]
    expect(count(document, /<w:footnoteReference /g)).toBe(occurrences);
    expect(footnotes).toContain("[1] Q3 Industry Report, p. 4. “Demand rose 12 percent”");
    expect(footnotes).toContain("[2] Price watch &quot;weekly&quot;. “Prices were flat for the third straight quarter.”");
    expect(footnotes).toContain("[4] Table “Prices 2025”, Pricing workbook.xlsx");
  });

  it("styles the title and headings, writes the table, nested numbering, highlight and links", async () => {
    const { document, rels } = await unzip(sampleInput());
    expect(document).toContain('<w:pStyle w:val="Title"/>');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
    expect(document).toContain('<w:pStyle w:val="Heading3"/>');
    expect(document).toContain("<w:tbl>");
    expect(document).toContain('<w:tblHeader/>');
    expect(document).toMatch(/<w:numPr><w:ilvl w:val="1"\/>/);
    expect(document).toContain('<w:highlight w:val="yellow"/>');
    expect(document).toContain("<w:strike/>");
    expect(document).toContain('w:ascii="Consolas"');
    expect(document).toContain("<w:hyperlink");
    expect(rels).toMatch(/Target="https:\/\/sasha\.app\/library" TargetMode="External"/);
    expect(rels).toContain('Target="https://example.com/a?b=1"');
    // The remote image is never fetched: its alt text stands in; the data image is embedded.
    expect(document).toContain("[Image: Remote]");
    expect(document).toContain("<w:drawing>");
    // The References list repeats the footnotes for readers.
    expect(document).toContain("References");
    expect(document).toContain("Some references may be out of date");
  });

  it("puts the title and the type into the document properties", async () => {
    const { core } = await unzip(sampleInput());
    expect(core).toContain("<dc:title>Market memo</dc:title>");
    expect(core).toContain("<dc:subject>Investment memo</dc:subject>");
    expect(core).toContain("<cp:keywords>investment-memo</cp:keywords>");
    expect(core).toContain("<dc:creator>Sasha</dc:creator>");
  });

  it("drops unsafe links to plain text", async () => {
    const input = { ...sampleInput(), references: [], numberOf: new Map<string, number>() };
    input.doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] };
    const { document, rels } = await unzip(input);
    expect(document).not.toContain("<w:hyperlink");
    expect(rels).not.toContain("javascript:");
  });

  it("strips the control characters XML forbids, so Word opens the file (text, table cells, title, footnotes)", async () => {
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    const input = { ...sampleInput(), title: "T\u0001x", typeTitle: "Memo\u000B" };
    const cell = (text: string) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    input.doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a\u000Bb\u0001c" }] },
        { type: "table", content: [{ type: "tableRow", content: [cell("x\u0002y"), cell("tab\tkept")] }] },
        ...(input.doc.content ?? []),
      ],
    };
    input.references = input.references.map((r) => ({ ...r, excerpt: r.excerpt ? `${r.excerpt}\u0007` : r.excerpt, sourceTitle: `${r.sourceTitle}\u001F` }));
    const { document, footnotes, core } = await unzip(input);
    for (const xml of [document, footnotes, core]) expect(xml).not.toMatch(bad);
    expect(document).toContain("abc");
    expect(document).toContain("xy");
    expect(core).toContain("<dc:title>Tx</dc:title>");
    expect(xmlSafe("ok\t\n\r é 😀 \uD800 \uFFFF")).toBe("ok\t\n\r é 😀  ");
  });
});

describe("docxImageSize", () => {
  it("keeps small images, caps wide ones at the column width with the aspect kept, and defaults unknown sizes", () => {
    expect(docxImageSize({ width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
    expect(docxImageSize({ width: 1248, height: 600 })).toEqual({ width: 624, height: 300 });
    expect(docxImageSize({ width: null, height: null })).toEqual({ width: 400, height: 300 });
  });
});
