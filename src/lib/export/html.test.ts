import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import { exportCitations, type ExportImages, type ExportInput } from "./contract";
import { printHtml } from "./html";
import { decodeDataImage, imageSources, toExportImage } from "./images";

const FIXTURES = path.join(__dirname, "__fixtures__");

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

const bare = (content: PMNode[], extra: Partial<ExportInput> = {}): ExportInput => ({
  doc: { type: "doc", content },
  title: "T",
  typeTitle: null,
  typeKey: null,
  references: [],
  numberOf: new Map(),
  origin: "https://sasha.app",
  images: new Map(),
  ...extra,
});

describe("printHtml", () => {
  it("matches the golden print document", () => {
    const html = printHtml(sampleInput());
    // SASHA_UPDATE_GOLDEN=1 rewrites the golden file after a deliberate change.
    if (process.env.SASHA_UPDATE_GOLDEN === "1") writeFileSync(path.join(FIXTURES, "sample.html"), html);
    expect(html).toBe(readFileSync(path.join(FIXTURES, "sample.html"), "utf8"));
  });

  it("numbers superscripts and endnotes the same way collectCitations does", () => {
    const input = sampleInput();
    const html = printHtml(input);
    const sups = [...html.matchAll(/<sup class="cite"><a href="#ref-(\d+)">(\d+)<\/a><\/sup>/g)].map((m) => Number(m[1]));
    expect(sups).toEqual([1, 2, 3, 1, 4]);
    const notes = [...html.matchAll(/<li id="ref-(\d+)"/g)].map((m) => Number(m[1]));
    expect(notes).toEqual(input.references.map((r) => r.number));
    expect(html).toContain('<li id="ref-3" class="stale-ref">');
  });

  it("is self-contained: a no-script CSP, inline CSS, no remote loads, only data: images", () => {
    const html = printHtml(sampleInput());
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:;`);
    expect(html).not.toMatch(/<link|@import|url\(/i);
    expect(html).not.toContain("evil.example");
    expect(html).toContain('<span class="image-missing">[Image: Remote]</span>');
    for (const m of html.matchAll(/<img src="([^"]*)"/g)) expect(m[1].startsWith("data:image/")).toBe(true);
    expect(html).toContain("<thead><tr><th>");
    expect(html).toContain("<mark>highlighted</mark>");
    expect(html).toContain("<u>underlined</u>");
  });

  it("neutralizes script, javascript: and event-handler payloads in text, attributes and hrefs", () => {
    const evil = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const html = printHtml(
      bare(
        [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: evil }] },
          { type: "paragraph", attrs: { textAlign: "left;background:url(https://x)", style: "color:red" }, content: [{ type: "text", text: "a", marks: [{ type: "link", attrs: { href: "javascript:alert(3)" } }] }] },
          { type: "paragraph", content: [{ type: "text", text: "b", marks: [{ type: "link", attrs: { href: " java\tscript:alert(4)" } }] }, { type: "text", text: "c", marks: [{ type: "link", attrs: { href: 'https://ok.example/"onmouseover="x' } }] }] },
          { type: "image", attrs: { src: "javascript:alert(5)", alt: evil } },
          { type: "image", attrs: { src: "data:text/html;base64,PHNjcmlwdD4=", alt: "html" } },
          { type: "rawHtml", attrs: { html: "<script>alert(6)</script>" }, content: [{ type: "text", text: "<b onclick=x>kept as text</b>" }] },
          { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: '2" onclick="x' }, content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }] }] }] },
        ],
        { title: evil, typeTitle: evil },
      ),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<[^>]+\son\w+=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/java\s*script/i);
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("color:red");
    expect(html).not.toContain("background:url");
    expect(html).toContain("&lt;b onclick=x&gt;kept as text&lt;/b&gt;");
    expect(html).toContain('href="https://ok.example/&quot;onmouseover=&quot;x"');
  });

  it("drops SVG images unless asked to keep them", () => {
    const svg = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E";
    const images: ExportImages = new Map([[svg, { mime: "image/svg+xml", data: new Uint8Array(1), dataUri: svg, width: null, height: null }]]);
    const input = bare([{ type: "image", attrs: { src: svg, alt: "Curve" } }], { images });
    expect(printHtml(input)).toContain("[Image: Curve]");
    expect(printHtml(input, { allowSvg: true })).toContain(`<img src="${svg}" alt="Curve">`);
  });
});
