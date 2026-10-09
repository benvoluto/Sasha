import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ontology/governance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ontology/governance")>()),
  defaultAuditSink: () => ({ write: async () => {} }),
}));

import { columnKey } from "@/lib/data/contract";
import { listTables, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import type { PMNode } from "@/lib/documents/sections";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { passagePrefix } from "@/lib/sources/pages";
import { createSource, deleteSource, linkSource, replacePassages, resetSourceStore, unlinkSource } from "@/lib/sources/store";
import { documentCitations, passageIndex, resolveReferences } from "./references";

const T = "org:a";

async function source(title: string, text: string, team = T) {
  const s = await createSource(team, "ann", { kind: "note", title, extracted_text: text, extraction_status: "ready" });
  const id = `${passagePrefix(s.id)}.P0`;
  await replacePassages(team, s.id, [{ id, idx: 0, page: 2, start_offset: 0, end_offset: text.length, text }]);
  return { s, id };
}

const cited = (text: string, attrs: Record<string, unknown>): PMNode => ({ type: "text", text, marks: [{ type: "citation", attrs }] });
const docOf = (...texts: PMNode[]): PMNode => ({ type: "doc", content: [{ type: "paragraph", content: texts }] });

describe("resolveReferences / documentCitations", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
  });

  it("resolves ok, unlinked, deleted and missing passages, and a table", async () => {
    const d = await createDocument(T, "ann");
    const ok = await source("Q3 Report", "Demand rose 12 percent.");
    const unlinked = await source("Old memo", "Prices held.");
    const gone = await source("Deleted notes", "Gone.");
    const reread = await source("Re-read file", "First text.");
    for (const x of [ok, unlinked, gone, reread]) await linkSource(T, "ann", d.id, x.s.id);
    await unlinkSource(T, d.id, unlinked.s.id);
    await deleteSource(T, gone.s.id);
    // Read again: the passage the citation names is no longer there.
    await replacePassages(T, reread.s.id, [{ id: `${passagePrefix(reread.s.id)}.P3`, idx: 3, page: null, start_offset: 0, end_offset: 5, text: "Other" }]);

    const tableSource = await createSource(T, "ann", { kind: "file", title: "Budget workbook", filename: "budget.xlsx", mime: "text/csv" });
    await linkSource(T, "ann", d.id, tableSource.id);
    await replaceSourceTables(T, tableSource.id, "ann", [
      {
        match_key: "costs",
        name: "Costs",
        columns: [{ key: columnKey(0), label: "Item", type: "text", inferred: "text", unit: null }],
        rows: [["Rent"]],
        extraction_method: "csv",
        sheet: null,
        page: 5,
        page_end: null,
        confidence: null,
        notes: "",
        truncated: false,
      },
    ]);
    const [tbl] = await listTables(T, { sourceId: tableSource.id });

    const content = docOf(
      cited("One.", { kind: "passage", passageId: ok.id, sourceId: ok.s.id, verified: true }),
      cited("Two.", { kind: "passage", passageId: unlinked.id, sourceId: unlinked.s.id }),
      cited("Three.", { kind: "passage", passageId: gone.id, sourceId: gone.s.id }),
      cited("Four.", { kind: "passage", passageId: reread.id, sourceId: reread.s.id }),
      cited("Costs", { kind: "table", dataTableId: tbl.id, sourceId: tableSource.id }),
      cited("Five.", { kind: "table", dataTableId: "00000000-0000-4000-8000-000000000000" }),
    );
    const { references, problems } = await documentCitations(T, d.id, content);
    expect(references.map((r) => [r.number, r.status, r.sourceTitle])).toEqual([
      [1, "ok", "Q3 Report"],
      [2, "unlinked", "Old memo"],
      [3, "deleted", "Deleted source"],
      [4, "missing", "Re-read file"],
      [5, "ok", "Budget workbook"],
      [6, "deleted", "Deleted source"],
    ]);
    expect(references[0]).toMatchObject({ page: 2, excerpt: "Demand rose 12 percent.", sourceUrl: null, fileName: null });
    // An upload's file name, so the exports cite it by title, file name and page rather than link into the app.
    expect(references[4]).toMatchObject({ kind: "table", tableName: "Costs", page: 5, fileName: "budget.xlsx" });
    expect(problems.map((p) => [p.number, p.status])).toEqual([
      [2, "unlinked"],
      [3, "deleted"],
      [4, "missing"],
      [6, "deleted"],
    ]);
  });

  it("finds the source from the passage prefix when the mark has no source id, and never another team's", async () => {
    const d = await createDocument(T, "ann");
    const mine = await source("Mine", "My text.");
    await linkSource(T, "ann", d.id, mine.s.id);
    const theirs = await source("Theirs", "Their text.", "org:b");
    const refs = await resolveReferences(T, d.id, [
      { key: `p:${mine.id}`, number: 1, kind: "passage", passageId: mine.id, sourceId: null, dataTableId: null, quote: null },
      { key: `p:${theirs.id}`, number: 2, kind: "passage", passageId: theirs.id, sourceId: theirs.s.id, dataTableId: null, quote: null },
    ]);
    expect(refs.map((r) => [r.status, r.sourceTitle])).toEqual([
      ["ok", "Mine"],
      ["deleted", "Deleted source"],
    ]);
    expect(passageIndex("S1a2b3c4d.P17")).toBe(17);
    expect(passageIndex("nope")).toBeNull();
  });

  it("gives a URL source's own address and an uploaded file's name", async () => {
    const d = await createDocument(T, "ann");
    const web = await createSource(T, "ann", { kind: "url", title: "Rates explained", url: "https://example.org/rates", extracted_text: "Rates rose.", extraction_status: "ready" });
    const file = await createSource(T, "ann", { kind: "file", title: "Q3 Report", filename: "q3.pdf", mime: "application/pdf", extracted_text: "Demand rose.", extraction_status: "ready" });
    for (const s of [web, file]) {
      await replacePassages(T, s.id, [{ id: `${passagePrefix(s.id)}.P0`, idx: 0, page: s === file ? 4 : null, start_offset: 0, end_offset: 5, text: "Text." }]);
      await linkSource(T, "ann", d.id, s.id);
    }
    const refs = await resolveReferences(T, d.id, [web, file].map((s, i) => ({ key: `p:${passagePrefix(s.id)}.P0`, number: i + 1, kind: "passage" as const, passageId: `${passagePrefix(s.id)}.P0`, sourceId: s.id, dataTableId: null, quote: null })));
    expect(refs.map((r) => [r.sourceTitle, r.sourceUrl, r.fileName, r.page])).toEqual([
      ["Rates explained", "https://example.org/rates", null, null],
      ["Q3 Report", null, "q3.pdf", 4],
    ]);
  });

  it("keeps a mark's quote only when the passage it resolves to contains it", async () => {
    const d = await createDocument(T, "ann");
    const ok = await source("Q3 Report", "Demand rose 12 percent in the third quarter.");
    await linkSource(T, "ann", d.id, ok.s.id);
    const ref = (quote: string | null, passageId = ok.id) => ({ key: `p:${passageId}`, number: 1, kind: "passage" as const, passageId, sourceId: ok.s.id, dataTableId: null, quote });
    const [real] = await resolveReferences(T, d.id, [ref("demand rose 12 percent")]);
    expect(real).toMatchObject({ status: "ok", quote: "demand rose 12 percent" });
    // A forged or outdated quote (pasted HTML, edited content_json, a re-read source) never prints as the source's words.
    const [forged] = await resolveReferences(T, d.id, [ref("The board admitted the figures were falsified")]);
    expect(forged).toMatchObject({ status: "ok", quote: null, excerpt: "Demand rose 12 percent in the third quarter." });
    const [missing] = await resolveReferences(T, d.id, [ref("Demand rose", `${passagePrefix(ok.s.id)}.P9`)]);
    expect(missing).toMatchObject({ status: "missing", quote: null });
    const [table] = await resolveReferences(T, d.id, [{ key: "t:x", number: 1, kind: "table", passageId: null, sourceId: null, dataTableId: "00000000-0000-4000-8000-000000000000", quote: "Anything" }]);
    expect(table.quote).toBeNull();
  });
});
