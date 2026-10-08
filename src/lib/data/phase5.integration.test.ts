// Phase 5 across its tracks, on the real in-memory stores: ingest stores a
// source's tables (CSV, XLSX, PDF), the document's Data routes link and list
// them, a page of rows becomes an inserted snapshot, a linked table covers a
// data suggestion (and "Add" records it), and deleting the source removes them.
// Only the network edges are mocked: blob download, Gemini and Claude.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  geminiText: vi.fn(),
  geminiTables: vi.fn(),
  summarize: vi.fn(),
  claudeJson: vi.fn(),
}));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/blob-download", () => ({ downloadBlobContent: mocks.download }));
vi.mock("@/lib/gemini", () => ({ processDocumentsWithGemini: mocks.geminiText }));
vi.mock("@/lib/sources/summarize", () => ({ summarizeSource: mocks.summarize }));
vi.mock("@/lib/data/gemini-tables", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/gemini-tables")>()),
  readGeminiTables: mocks.geminiTables,
}));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeJson: mocks.claudeJson,
  claudeConfigured: () => true,
}));

import * as XLSX from "xlsx";
import { GET as getDocumentData, POST as linkDocumentData } from "@/app/api/documents/[id]/data/route";
import { PATCH as patchSuggestion } from "@/app/api/documents/[id]/suggestions/[suggestionId]/route";
import { GET as getTableRoute } from "@/app/api/data/tables/[id]/route";
import type { LinkedDataTable, TableResponse } from "@/lib/data/contract";
import { tableSnapshotNodes } from "@/lib/data/snapshot";
import { listDocumentTables, listTables, resetDataStore } from "@/lib/data/store";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { ingestSource } from "@/lib/sources/ingest";
import { createSource, deleteSource, getSource, resetSourceStore, setSourceFile } from "@/lib/sources/store";
import { fileTypeByKey } from "@/catalog/files";
import { typeNeeds } from "@/lib/suggestions/diff";
import { generateSuggestions, resetSuggestionGenerator } from "@/lib/suggestions/generate";
import { resetSuggestionStore } from "@/lib/suggestions/store";

const T = "org:a";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function fileSource(mime: string, filename: string) {
  const s = await createSource(T, "ann", { kind: "file", filename, mime });
  await setSourceFile(T, s.id, { blob_url: `https://abc.public.blob.vercel-storage.com/sources/${s.id}/${filename}`, blob_pathname: `sources/${s.id}/${filename}`, bytes: 10, mime, status: "pending" });
  return s;
}

const docCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("Phase 5 end to end (memory stores)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    resetSuggestionStore();
    resetSuggestionGenerator();
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.summarize.mockResolvedValue({ summary: "A short summary.", title: null });
  });

  it("ingest stores CSV, XLSX and PDF tables in the data store", async () => {
    const csv = await fileSource("text/csv", "budget.csv");
    mocks.download.mockResolvedValueOnce(Buffer.from("Item,Cost\nPaper,$5\nInk,$12\n"));
    await ingestSource(T, csv.id, "ann");
    expect((await getSource(T, csv.id))?.extraction_status).toBe("ready");

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Region", "Sales"], ["North", 10], ["South", 20]]), "Q1");
    const xlsx = await fileSource(XLSX_MIME, "sales.xlsx");
    mocks.download.mockResolvedValueOnce(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    await ingestSource(T, xlsx.id, "ann");
    expect((await getSource(T, xlsx.id))?.extraction_status).toBe("ready");

    const pdf = await fileSource("application/pdf", "report.pdf");
    mocks.download.mockResolvedValueOnce(Buffer.from("%PDF-1.4"));
    mocks.geminiText.mockResolvedValueOnce({ status: "success", extractedContent: "=== Document: report.pdf ===\n--- Page 1 ---\nRevenue grew.", processedAt: "", fileCount: 1 });
    mocks.geminiTables.mockResolvedValueOnce({
      ok: true,
      grids: [{ name: "Revenue", match_key: "page:1#1", cells: [["Year", "Revenue"], ["2024", "$1,200"], ["2025", "$1,800"]], truncated: false, method: "gemini-pdf", page: 1, confidence: 0.9, header_rows: 1 }],
      warnings: [],
      dropped: [],
    });
    await ingestSource(T, pdf.id, "ann");
    expect((await getSource(T, pdf.id))?.extraction_status).toBe("ready");

    const tables = await listTables(T);
    const bySource = new Map(tables.map((t) => [t.source_id, t]));
    expect(bySource.get(csv.id)).toMatchObject({ extraction_method: "csv", row_count: 2, columns: [{ label: "Item" }, { label: "Cost", type: "currency" }] });
    expect(bySource.get(xlsx.id)).toMatchObject({ extraction_method: "xlsx", sheet: "Q1", row_count: 2, columns: [{ label: "Region" }, { label: "Sales", type: "number" }] });
    expect(bySource.get(pdf.id)).toMatchObject({ extraction_method: "gemini-pdf", page: 1, row_count: 2, columns: [{ label: "Year" }, { label: "Revenue" }] });
  });

  it("links a table, inserts a snapshot, covers a data suggestion, and goes away with its source", async () => {
    const src = await fileSource("text/csv", "traction.csv");
    mocks.download.mockResolvedValueOnce(Buffer.from("Month,Revenue\nJan,100\nFeb,150\nMar,=1+1\n"));
    await ingestSource(T, src.id, "ann");
    const [table] = await listTables(T, { sourceId: src.id });
    expect(table).toBeTruthy();

    // Data tab: link, then list.
    const doc = await createDocument(T, "ann", { type_key: "business-plan" });
    const linked = await linkDocumentData(new Request(`http://x/api/documents/${doc.id}/data`, { method: "POST", body: JSON.stringify({ table_id: table.id }) }), docCtx(doc.id));
    expect(linked.status).toBe(200);
    const list = (await (await getDocumentData(new Request(`http://x/api/documents/${doc.id}/data`), docCtx(doc.id))).json()) as { tables: LinkedDataTable[] };
    expect(list.tables.map((t) => t.id)).toEqual([table.id]);

    // Insert: a page of rows → the snapshot nodes, formulas neutralized.
    const page = (await (await getTableRoute(new Request(`http://x/api/data/tables/${table.id}?offset=0&limit=100`), docCtx(table.id))).json()) as TableResponse;
    expect(page.rows).toHaveLength(3);
    const [tableNode, citation] = tableSnapshotNodes({ table: page.table, rows: page.rows }, { rows: 25, at: "2026-10-08T00:00:00.000Z" });
    expect(tableNode.attrs).toMatchObject({ dataTableId: table.id, sourceId: src.id });
    expect(tableNode.content).toHaveLength(4);
    expect(JSON.stringify(tableNode)).toContain("'=1+1");
    expect(JSON.stringify(citation)).toContain(`table=${table.id}`);

    // Suggestions: the model may cover a data item with the linked table.
    const dataItem = typeNeeds(fileTypeByKey("business-plan")!).findIndex((i) => i.kind === "data") + 1;
    mocks.claudeJson.mockImplementation(async ({ user }: { user: string }) => {
      expect(user).toContain(table.id);
      return { data: { coverage: [{ item: dataItem, status: "covered", source_id: table.id }], proposals: [] } };
    });
    const generated = await generateSuggestions(T, doc.id, { force: true });
    const items = generated!.suggestions;
    const first = items.find((s) => s.kind === "data" && s.state === "added");
    expect(first).toMatchObject({ data_table_id: table.id });

    // "Add" on another open data item records the table it was added with.
    const open = items.find((s) => s.kind === "data" && s.state === "open")!;
    const added = await patchSuggestion(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ action: "add", data_table_id: table.id }) }),
      { params: Promise.resolve({ id: doc.id, suggestionId: open.id }) },
    );
    expect(added.status).toBe(200);
    expect((await added.json()).suggestion).toMatchObject({ state: "added", data_table_id: table.id });

    // Deleting the source removes its tables and the document's links to them.
    await deleteSource(T, src.id);
    expect(await listTables(T)).toEqual([]);
    expect(await listDocumentTables(T, doc.id)).toEqual([]);
  });
});
