import { describe, expect, it } from "vitest";
import { splitDocuments } from "@/lib/sources/split";
import { findDocument, listDocuments, readDocument, searchText } from "./tools";

const docs = splitDocuments(
  "g",
  "=== Document: Budget.pdf ===\nTotal revenue was 1.2 million in 2025.\n=== Document: Notes.docx ===\nThe team met twice. Revenue targets were discussed.",
);

describe("assistant tools", () => {
  it("lists one entry per source file", () => {
    expect(listDocuments(docs).documents.map((d) => d.name)).toEqual(["Budget.pdf", "Notes.docx"]);
  });

  it("finds a source by id, index, or name", () => {
    expect(findDocument(docs, "g-1")?.doc_type).toBe("Notes.docx");
    expect(findDocument(docs, "0")?.doc_type).toBe("Budget.pdf");
    expect(findDocument(docs, "notes")?.doc_type).toBe("Notes.docx");
  });

  it("reads a source's text, and errors on an unknown one", () => {
    expect(readDocument(docs, "Budget.pdf")).toMatchObject({ name: "Budget.pdf", truncated: false });
    expect(readDocument(docs, "missing")).toHaveProperty("error");
  });

  it("searches every source, case-insensitively", () => {
    const r = searchText(docs, "revenue") as { total: number; hits: Array<{ name: string }> };
    expect(r.total).toBe(2);
    expect(r.hits.map((h) => h.name)).toEqual(["Budget.pdf", "Notes.docx"]);
    expect(searchText(docs, "  ")).toHaveProperty("error");
  });
});
