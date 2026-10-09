import { describe, expect, it } from "vitest";
import type { ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import {
  citationEnds,
  contentDisposition,
  countCitationOccurrences,
  exportCitations,
  exportFilename,
  isLibraryHref,
  referenceExcerpt,
  referenceHref,
  referenceLabel,
  referenceLine,
  safeHref,
  staleNote,
  tableLinkCitation,
} from "./contract";

const cite = (passageId: string) => ({ type: "citation", attrs: { kind: "passage", passageId, sourceId: "src-1" } });

describe("exportFilename", () => {
  it("keeps letters (any script), digits and simple punctuation, and falls back when nothing is left", () => {
    expect(exportFilename("Q3 memo: draft/final?", "docx")).toBe("Q3 memo draft final.docx");
    expect(exportFilename("Résumé — Zoë 日本", "md")).toBe("Résumé Zoë 日本.md");
    expect(exportFilename("  ...hidden.  ", "pdf")).toBe("hidden.pdf");
    expect(exportFilename("<<>>", "pdf")).toBe("Untitled document.pdf");
    expect(exportFilename("", "md")).toBe("Untitled document.md");
    expect(exportFilename("x".repeat(200), "md")).toBe(`${"x".repeat(80)}.md`);
    expect(exportFilename("../../etc/passwd", "md")).toBe("etc passwd.md");
  });
});

describe("contentDisposition", () => {
  it("writes an ASCII fallback and the UTF-8 name", () => {
    expect(contentDisposition("Résumé.pdf")).toBe(`attachment; filename="R_sum_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`);
    expect(contentDisposition('a"b\\c.md', true)).toBe(`inline; filename="a_b_c.md"; filename*=UTF-8''a%22b%5Cc.md`);
  });
});

describe("citations for export", () => {
  it("reads legacy table links, relative or absolute, and nothing else", () => {
    expect(tableLinkCitation("/library?source=s1&table=t1")).toEqual({ sourceId: "s1", dataTableId: "t1" });
    expect(tableLinkCitation("https://sasha.app/library?source=s%201&table=t1")).toEqual({ sourceId: "s 1", dataTableId: "t1" });
    expect(tableLinkCitation("/library?source=s1")).toBeNull();
    expect(tableLinkCitation("/elsewhere?source=s1&table=t1")).toBeNull();
    expect(tableLinkCitation(42)).toBeNull();
  });

  it("numbers legacy table links with the citation marks, by first appearance, and leaves no library link", () => {
    const doc: PMNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Table", marks: [{ type: "link", attrs: { href: "/library?source=s1&table=t1" } }] }] },
        { type: "paragraph", content: [{ type: "text", text: "Claim.", marks: [cite("S1a2b3c4d.P1")] }] },
      ],
    };
    const { references, numberOf, doc: out } = exportCitations(doc);
    expect(references.map((r) => r.key)).toEqual(["t:t1", "p:S1a2b3c4d.P1"]);
    expect(numberOf.get("t:t1")).toBe(1);
    // The table's "Source:" line keeps its text and gains the table citation; the in-app link goes.
    expect(out.content?.[0].content?.[0]).toMatchObject({ text: "Table" });
    expect(out.content?.[0].content?.[0].marks?.map((m) => m.type)).toEqual(["citation"]);
    // The input is not mutated.
    expect(doc.content?.[0].content?.[0].marks).toHaveLength(1);
  });

  it("drops any relative library link to its text, and keeps other links", () => {
    const link = (href: string): PMNode => ({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }, { type: "bold" }] }] });
    const { doc: out } = exportCitations({ type: "doc", content: [link("/library?source=s1"), link("https://example.com/library"), link("/d/1")] });
    expect(out.content!.map((p) => p.content![0].marks!.map((m) => m.type))).toEqual([["bold"], ["link", "bold"], ["link", "bold"]]);
  });

  it("recognizes library links: relative, or absolute on the app's origin", () => {
    expect(isLibraryHref("/library?source=s1&passage=S1.P2")).toBe(true);
    expect(isLibraryHref("/library/x")).toBe(true);
    expect(isLibraryHref("https://sasha.app/library?source=s1", "https://sasha.app")).toBe(true);
    expect(isLibraryHref("https://sasha.app/library?source=s1")).toBe(false);
    expect(isLibraryHref("https://example.com/library", "https://sasha.app")).toBe(false);
    expect(isLibraryHref("/libraryish")).toBe(false);
    expect(isLibraryHref(null)).toBe(false);
  });

  it("places numbers at the end of each run, once per occurrence", () => {
    const numberOf = new Map([
      ["p:A", 1],
      ["p:B", 2],
    ]);
    const inl: PMNode[] = [
      { type: "text", text: "a", marks: [cite("A")] },
      { type: "text", text: "b", marks: [cite("A"), cite("B")] },
      { type: "text", text: "c" },
      { type: "text", text: "d", marks: [cite("A")] },
    ];
    expect(citationEnds(inl, numberOf)).toEqual([[], [1, 2], [], [1]]);
    expect(countCitationOccurrences({ type: "doc", content: [{ type: "paragraph", content: inl }] }, numberOf)).toBe(3);
  });
});

describe("references as text", () => {
  const ref = (over: Partial<ResolvedReference>): ResolvedReference => ({
    key: "p:S1a2b3c4d.P1",
    number: 1,
    kind: "passage",
    passageId: "S1a2b3c4d.P1",
    sourceId: "src 1",
    dataTableId: null,
    quote: null,
    status: "ok",
    sourceTitle: "Report",
    sourceUrl: null,
    page: 3,
    excerpt: "Long text ".repeat(40),
    tableName: null,
    ...over,
  });

  it("writes the label and a cut excerpt, or the table line", () => {
    expect(referenceLine(ref({}), 30)).toBe("Report, p. 3. “Long text Long text Long text…”");
    expect(referenceLine(ref({ quote: "the words" }))).toBe("Report, p. 3. “the words”");
    expect(referenceLine(ref({ kind: "table", tableName: "Prices", sourceTitle: "Book.xlsx", page: null }))).toBe("Table “Prices”, Book.xlsx");
  });

  it("links only to a URL source's own address, never the in-app library", () => {
    expect(referenceHref(ref({}), "https://sasha.app")).toBeNull();
    expect(referenceHref(ref({ kind: "table", dataTableId: "t1" }), "https://sasha.app")).toBeNull();
    expect(referenceHref(ref({ sourceUrl: "https://news.example/a" }), "https://sasha.app")).toBe("https://news.example/a");
    for (const bad of ["javascript:alert(1)", "/library?source=s1", "https://sasha.app/library?source=s1", "//evil.example/x"]) expect(referenceHref(ref({ sourceUrl: bad }), "https://sasha.app")).toBeNull();
  });

  it("cites an upload by title, file name and page, and a URL source by title and address", () => {
    expect(referenceLabel({ ...ref({}), fileName: "q3-report.pdf" })).toBe("Report (q3-report.pdf), p. 3");
    expect(referenceLabel({ ...ref({ sourceTitle: "q3-report.pdf" }), fileName: "q3-report.pdf" })).toBe("q3-report.pdf, p. 3");
    expect(referenceLabel(ref({ sourceTitle: "Rates explained", sourceUrl: "https://example.org/rates", page: null }))).toBe("Rates explained, https://example.org/rates");
    // A URL source with no title already reads as its address: not repeated.
    expect(referenceLabel(ref({ sourceTitle: "https://example.org/rates", sourceUrl: "https://example.org/rates", page: null }))).toBe("https://example.org/rates");
    expect(referenceLabel({ ...ref({ kind: "table", tableName: "Prices", sourceTitle: "Pricing", page: 2 }), fileName: "prices.xlsx" })).toBe("Table “Prices”, Pricing (prices.xlsx), p. 2");
  });

  it("prints excerpts as plain text, not the passage's Markdown", () => {
    expect(referenceExcerpt(ref({ excerpt: "## Results\n\n**Demand** rose [12%](https://x.example) in _2025_.\n\n| Year | Sales |\n|---|---|\n| 2025 | 12 |" }))).toBe("“Results Demand rose 12% in 2025. Year · Sales 2025 · 12”");
    expect(referenceExcerpt(ref({ excerpt: "![chart](a.png)" }))).toBeNull();
  });

  it("notes stale references only", () => {
    expect(staleNote([ref({})])).toBeNull();
    expect(staleNote([ref({ number: 2, status: "unlinked" }), ref({ number: 3, status: "deleted" })])).toBe(
      "Some references may be out of date: 2, the source was unlinked from this document; 3, the source was deleted.",
    );
  });

  it("allows http(s) and mailto links, absolutizes relative ones, refuses the rest", () => {
    expect(safeHref("/d/1", "https://sasha.app")).toBe("https://sasha.app/d/1");
    expect(safeHref("#x", "https://sasha.app")).toBe("https://sasha.app/#x");
    expect(safeHref("mailto:a@b.example", "https://sasha.app")).toBe("mailto:a@b.example");
    for (const bad of ["javascript:alert(1)", "java\tscript:x", "data:text/html,x", "//evil.example/a", "file:///etc/passwd", ""]) expect(safeHref(bad, "https://sasha.app")).toBeNull();
  });
});
