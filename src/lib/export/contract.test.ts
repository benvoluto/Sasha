import { describe, expect, it } from "vitest";
import type { ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import {
  citationEnds,
  contentDisposition,
  countCitationOccurrences,
  exportCitations,
  exportFilename,
  referenceHref,
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

  it("numbers legacy table links with the citation marks, by first appearance", () => {
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
    expect(out.content?.[0].content?.[0].marks?.map((m) => m.type)).toEqual(["link", "citation"]);
    // The input is not mutated.
    expect(doc.content?.[0].content?.[0].marks).toHaveLength(1);
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

  it("links to the library, else the source URL", () => {
    expect(referenceHref(ref({}), "https://sasha.app")).toBe("https://sasha.app/library?source=src%201&passage=S1a2b3c4d.P1");
    expect(referenceHref(ref({ sourceId: null, sourceUrl: "https://news.example/a" }), "https://sasha.app")).toBe("https://news.example/a");
    expect(referenceHref(ref({ sourceId: null, sourceUrl: "javascript:alert(1)" }), "https://sasha.app")).toBeNull();
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
