import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => ({ write: vi.fn<(e: { action: string }) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/ontology/governance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ontology/governance")>()),
  defaultAuditSink: () => audit,
}));

import { createDocument, deleteDocument, resetMemoryStore } from "@/lib/documents/store";
import { createSource, deleteSource, linkSource, resetSourceStore } from "@/lib/sources/store";
import { createUserSuggestion, getSuggestion, resetSuggestionStore, setSuggestionState } from "@/lib/suggestions/store";
import { columnKey, type ColumnType, type ExtractedTable } from "./contract";
import { getTable, getTableRows, linkTable, listDocumentTables, listTables, patchTable, replaceSourceTables, resetDataStore, unlinkTable } from "./store";

const A = "org:a";
const B = "org:b";

const table = (name: string, match_key: string, opts: { rows?: (string | null)[][]; labels?: string[]; types?: ColumnType[] } = {}): ExtractedTable => {
  const labels = opts.labels ?? ["Item", "Cost"];
  return {
    match_key,
    name,
    columns: labels.map((label, i) => ({ key: columnKey(i), label, type: opts.types?.[i] ?? "text", inferred: opts.types?.[i] ?? "text", unit: null })),
    rows: opts.rows ?? [
      ["Rent", "100"],
      ["Power", "40"],
      ["Water", "=SUM(A1)"],
    ],
    extraction_method: "csv",
    sheet: null,
    page: null,
    page_end: null,
    confidence: null,
    notes: "",
    truncated: false,
  };
};

const source = (team = A, title = "Budget.csv") => createSource(team, "ann", { kind: "file", title, filename: title, mime: "text/csv" });

/** One source with one table; returns the table's id. */
async function seed(team = A, t = table("Budget", "csv")) {
  const s = await source(team);
  await replaceSourceTables(team, s.id, "ann", [t]);
  const [only] = await listTables(team, { sourceId: s.id });
  return { source: s, id: only.id };
}

describe("data store (memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    resetSuggestionStore();
    audit.write.mockClear();
  });

  it("inserts tables with their source, keeps team isolation, and pages rows", async () => {
    const s = await source();
    const many = Array.from({ length: 7 }, (_, i) => [`r${i}`, String(i)]);
    expect(await replaceSourceTables(A, s.id, "ann", [table("First", "sheet:1", { rows: many }), table("Second", "sheet:2")])).toEqual({ inserted: 2, superseded: 0 });
    const list = await listTables(A, { sourceId: s.id });
    expect(list.map((t) => t.name)).toEqual(["First", "Second"]);
    expect(list[0]).toMatchObject({ source_id: s.id, source: { id: s.id, title: "Budget.csv", kind: "file" }, row_count: 7, status: "active", override_count: 0, document_ids: [] });

    // Another team sees nothing, and can't write into this source.
    expect(await listTables(B)).toEqual([]);
    expect(await getTable(B, list[0].id)).toBeNull();
    expect(await getTableRows(B, list[0].id, 0, 10)).toBeNull();
    expect(await replaceSourceTables(B, s.id, "bob", [table("X", "csv")])).toBeNull();

    const page = (await getTableRows(A, list[0].id, 5, 10))!;
    expect(page.map((r) => [r.idx, r.cells])).toEqual([
      [5, ["r5", "5"]],
      [6, ["r6", "6"]],
    ]);
    expect(await getTableRows(A, list[0].id, 100, 10)).toEqual([]);
    expect(await getTable(A, "not-a-uuid")).toBeNull();
  });

  it("supersedes on a re-read, relinks by match_key, carries hidden, and drops overrides", async () => {
    const s = await source();
    await replaceSourceTables(A, s.id, "ann", [table("Kept", "sheet:Kept"), table("Gone", "sheet:Gone"), table("Hidden", "sheet:Hidden")]);
    const before = await listTables(A, { sourceId: s.id, status: ["active"] });
    const id = (name: string) => before.find((t) => t.name === name)!.id;
    const doc = await createDocument(A, "ann");
    await linkTable(A, "ann", doc.id, id("Kept"));
    await patchTable(A, "ann", id("Hidden"), { op: "hide" });
    await patchTable(A, "ann", id("Kept"), { op: "override", row: 0, key: "c2", value: "999" });
    await patchTable(A, "ann", id("Kept"), { op: "rename", name: "Renamed" });
    audit.write.mockClear();

    expect(await replaceSourceTables(A, s.id, "ingest", [table("Kept fresh", "sheet:Kept"), table("Hidden", "sheet:Hidden"), table("New", "sheet:New")])).toEqual({
      inserted: 3,
      superseded: 3,
    });
    const all = await listTables(A, { sourceId: s.id, status: ["active", "hidden", "superseded"] });
    const fresh = all.find((t) => t.name === "Kept fresh")!;
    // The new table takes the fresh name, the links and nothing else.
    expect(fresh).toMatchObject({ status: "active", document_ids: [doc.id], override_count: 0 });
    expect((await getTableRows(A, fresh.id, 0, 1))![0].cells).toEqual(["Rent", "100"]);
    expect(all.find((t) => t.id === id("Kept"))).toMatchObject({ status: "superseded", superseded_by: fresh.id, document_ids: [] });
    expect(all.find((t) => t.id === id("Gone"))).toMatchObject({ status: "superseded", superseded_by: null });
    const hiddenNew = all.find((t) => t.name === "Hidden" && t.id !== id("Hidden"))!;
    expect(hiddenNew.status).toBe("hidden");
    expect(all.find((t) => t.id === id("Hidden"))).toMatchObject({ status: "superseded", superseded_by: hiddenNew.id });
    expect(all.find((t) => t.name === "New")!.status).toBe("active");
    expect((await listDocumentTables(A, doc.id))!.map((t) => t.id)).toEqual([fresh.id]);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "ingest", action: "data_table.relink", args: expect.objectContaining({ team_id: A, table_id: fresh.id, source_id: s.id, document_id: doc.id }), groupId: fresh.id }),
    );

    // A pass that found no tables supersedes everything.
    expect(await replaceSourceTables(A, s.id, "ingest", [])).toEqual({ inserted: 0, superseded: 3 });
    expect(await listTables(A, { sourceId: s.id, status: ["active", "hidden"] })).toEqual([]);
  });

  it("moves a data suggestion a table covered to the table that replaces it", async () => {
    const { source: s, id: oldId } = await seed();
    const doc = await createDocument(A, "ann");
    await linkTable(A, "ann", doc.id, oldId);
    const { suggestion } = (await createUserSuggestion(A, "ann", doc.id, { kind: "data", label: "Cost figures" }))!;
    await setSuggestionState(A, doc.id, suggestion.id, "add", null, oldId);

    await replaceSourceTables(A, s.id, "ingest", [table("Budget", "csv")]);
    const [fresh] = await listTables(A, { sourceId: s.id });
    expect(fresh.id).not.toBe(oldId);
    expect(await getSuggestion(A, doc.id, suggestion.id)).toMatchObject({ state: "added", data_table_id: fresh.id });
  });

  it("keeps earlier tables on pages a partly failed re-read couldn't read", async () => {
    const s = await source(A, "report.pdf");
    const onPage = (name: string, page: number) => ({ ...table(name, `page:${page}#1`), extraction_method: "gemini-pdf" as const, page });
    await replaceSourceTables(A, s.id, "ann", [onPage("Early", 3), onPage("Middle", 24), onPage("Late", 120)]);
    const doc = await createDocument(A, "ann");
    const before = await listTables(A, { sourceId: s.id });
    const middle = before.find((t) => t.name === "Middle")!;
    await linkTable(A, "ann", doc.id, middle.id);

    // Pages 21-30 failed and pages past 100 weren't read; page 3 was read again.
    const r = await replaceSourceTables(A, s.id, "ingest", [onPage("Early again", 3)], { keepPages: [{ first: 21, last: 30 }, { first: 101, last: null }] });
    expect(r).toEqual({ inserted: 1, superseded: 1 });
    const active = await listTables(A, { sourceId: s.id });
    expect(active.map((t) => t.name).sort()).toEqual(["Early again", "Late", "Middle"]);
    expect(active.find((t) => t.name === "Middle")).toMatchObject({ id: middle.id, status: "active", document_ids: [doc.id] });
  });

  it("never leaves two active sets when two re-reads of a source overlap", async () => {
    const s = await source();
    await replaceSourceTables(A, s.id, "ann", [table("Budget", "csv")]);
    await Promise.all([
      replaceSourceTables(A, s.id, "ingest", [table("Budget A", "csv", { rows: Array.from({ length: 50 }, (_, i) => [`r${i}`, "1"]) })]),
      replaceSourceTables(A, s.id, "ingest", [table("Budget B", "csv")]),
    ]);
    const active = await listTables(A, { sourceId: s.id, status: ["active", "hidden"] });
    expect(active.map((t) => t.name)).toEqual(["Budget B"]);
  });

  it("hides and unhides only from the right state", async () => {
    const { id } = await seed();
    expect(await patchTable(A, "ann", id, { op: "unhide" })).toEqual({ ok: false, reason: "invalid_state" });
    expect(await patchTable(A, "ann", id, { op: "hide" })).toMatchObject({ ok: true, table: { status: "hidden" } });
    expect(await patchTable(A, "ann", id, { op: "hide" })).toEqual({ ok: false, reason: "invalid_state" });
    expect(await listTables(A)).toEqual([]);
    expect((await listTables(A, { status: ["hidden"] })).map((t) => t.id)).toEqual([id]);
    expect(await patchTable(A, "ann", id, { op: "unhide" })).toMatchObject({ ok: true, table: { status: "active" } });
    expect(await patchTable(B, "bob", id, { op: "hide" })).toEqual({ ok: false, reason: "not_found" });
    expect(audit.write.mock.calls.map((c) => c[0].action)).toEqual(["data_table.hide", "data_table.unhide"]);
  });

  it("applies a person's supersede with its rules, and restores", async () => {
    const one = await seed();
    const two = await seed();
    const three = await seed();
    const theirs = await seed(B);
    expect(await patchTable(A, "ann", one.id, { op: "supersede", by: one.id })).toEqual({ ok: false, reason: "invalid_supersede" });
    expect(await patchTable(A, "ann", one.id, { op: "supersede", by: theirs.id })).toEqual({ ok: false, reason: "invalid_supersede" });
    expect(await patchTable(A, "ann", one.id, { op: "restore" })).toEqual({ ok: false, reason: "not_superseded" });

    const doc = await createDocument(A, "ann");
    await linkTable(A, "ann", doc.id, one.id);
    const r = await patchTable(A, "ann", one.id, { op: "supersede", by: two.id });
    // The links stay; the Data tab offers "Use newer table".
    expect(r).toMatchObject({ ok: true, table: { status: "superseded", superseded_by: two.id, document_ids: [doc.id] } });
    // Superseded targets and repeated supersedes are refused.
    expect(await patchTable(A, "ann", three.id, { op: "supersede", by: one.id })).toEqual({ ok: false, reason: "invalid_supersede" });
    expect(await patchTable(A, "ann", one.id, { op: "supersede", by: three.id })).toEqual({ ok: false, reason: "invalid_state" });

    expect(await patchTable(A, "ann", one.id, { op: "restore" })).toMatchObject({ ok: true, table: { status: "active", superseded_by: null } });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: "data_table.supersede", args: expect.objectContaining({ by: two.id }) }));
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: "data_table.restore" }));
  });

  it("refuses a supersede that would lead back to the table", async () => {
    const one = await seed();
    const two = await seed();
    expect(await patchTable(A, "ann", one.id, { op: "supersede", by: two.id })).toMatchObject({ ok: true });
    expect(await patchTable(A, "ann", two.id, { op: "supersede", by: one.id })).toEqual({ ok: false, reason: "invalid_supersede" });
  });

  it("renames and changes columns, reverting a type to the inferred one", async () => {
    const { id } = await seed(A, table("Budget", "csv", { types: ["text", "number"] }));
    expect(await patchTable(A, "ann", id, { op: "rename", name: "Costs" })).toMatchObject({ ok: true, table: { name: "Costs" } });
    expect(await patchTable(A, "ann", id, { op: "column", key: "c9", label: "x" })).toEqual({ ok: false, reason: "column_not_found" });
    const changed = await patchTable(A, "ann", id, { op: "column", key: "c2", label: "Amount", type: "currency" });
    expect(changed.ok && changed.table.columns[1]).toMatchObject({ label: "Amount", type: "currency", inferred: "number" });
    const back = await patchTable(A, "ann", id, { op: "column", key: "c2", type: null });
    expect(back.ok && back.table.columns[1]).toMatchObject({ label: "Amount", type: "number" });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: "data_table.rename", args: expect.objectContaining({ name: "Costs", old: "Budget" }) }));
  });

  it("overrides a cell, keeps the original through changes, and reverts", async () => {
    const { id, source: s } = await seed();
    expect(await patchTable(A, "ann", id, { op: "override", row: 3, key: "c2", value: "1" })).toEqual({ ok: false, reason: "row_not_found" });
    expect(await patchTable(A, "ann", id, { op: "override", row: 0, key: "c7", value: "1" })).toEqual({ ok: false, reason: "column_not_found" });
    expect(await patchTable(A, "ann", id, { op: "revert", row: 0, key: "c2" })).toEqual({ ok: false, reason: "no_override" });

    const set = await patchTable(A, "ann", id, { op: "override", row: 0, key: "c2", value: "120" });
    expect(set).toMatchObject({ ok: true, table: { override_count: 1 }, row: { idx: 0, cells: ["Rent", "120"], overrides: { c2: { original: "100", by: "ann" } } } });
    const changed = await patchTable(A, "bea", id, { op: "override", row: 0, key: "c2", value: "130" });
    expect(changed).toMatchObject({ ok: true, row: { cells: ["Rent", "130"], overrides: { c2: { original: "100", by: "bea" } } } });
    expect(audit.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent: "bea", action: "data_table.override", args: { team_id: A, table_id: id, source_id: s.id, row: 0, key: "c2", old: "120", new: "130" }, allowed: true, groupId: id }),
    );
    // A value equal to the original is a revert.
    const same = await patchTable(A, "ann", id, { op: "override", row: 0, key: "c2", value: "100" });
    expect(same).toMatchObject({ ok: true, table: { override_count: 0 }, row: { cells: ["Rent", "100"] } });
    expect(same.ok && same.row?.overrides).toBeUndefined();
    expect(audit.write).toHaveBeenLastCalledWith(expect.objectContaining({ action: "data_table.revert", args: expect.objectContaining({ old: "130", new: "100" }) }));

    await patchTable(A, "ann", id, { op: "override", row: 1, key: "c1", value: null });
    expect((await getTableRows(A, id, 0, 3))!.map((r) => r.cells)).toEqual([
      ["Rent", "100"],
      [null, "40"],
      ["Water", "=SUM(A1)"],
    ]);
    const reverted = await patchTable(A, "ann", id, { op: "revert", row: 1, key: "c1" });
    expect(reverted).toMatchObject({ ok: true, row: { cells: ["Power", "40"] } });
    expect(audit.write).toHaveBeenLastCalledWith(expect.objectContaining({ action: "data_table.revert", args: expect.objectContaining({ row: 1, key: "c1", old: null, new: "Power" }) }));
  });

  it("logs a failed audit write and still makes the change", async () => {
    const { id } = await seed();
    audit.write.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await patchTable(A, "ann", id, { op: "hide" })).toMatchObject({ ok: true, table: { status: "hidden" } });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("links and unlinks idempotently, scoped to the team", async () => {
    const { id } = await seed();
    const doc = await createDocument(A, "ann");
    const theirDoc = await createDocument(B, "bob");
    expect(await linkTable(A, "ann", doc.id, id)).toBe("ok");
    expect(await linkTable(A, "bea", doc.id, id)).toBe("ok");
    const linked = (await listDocumentTables(A, doc.id))!;
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ id, added_by: "ann", document_ids: [doc.id] });
    expect(audit.write.mock.calls.filter((c) => c[0].action === "data_table.link")).toHaveLength(1);

    expect(await linkTable(A, "ann", theirDoc.id, id)).toBe("document_not_found");
    expect(await linkTable(B, "bob", theirDoc.id, id)).toBe("table_not_found");
    expect(await listDocumentTables(B, doc.id)).toBeNull();

    expect(await unlinkTable(B, doc.id, id, "bob")).toBe(false);
    expect(await unlinkTable(A, doc.id, id, "ann")).toBe(true);
    expect(await unlinkTable(A, doc.id, id, "ann")).toBe(false);
    expect(await listDocumentTables(A, doc.id)).toEqual([]);
    expect(audit.write).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "ann", action: "data_table.unlink", args: expect.objectContaining({ document_id: doc.id }) }));
  });

  it("lists linked tables in any status, oldest link first", async () => {
    const one = await seed();
    const two = await seed();
    const doc = await createDocument(A, "ann");
    await linkTable(A, "ann", doc.id, two.id);
    await linkTable(A, "ann", doc.id, one.id);
    await patchTable(A, "ann", two.id, { op: "hide" });
    expect((await listDocumentTables(A, doc.id))!.map((t) => [t.id, t.status])).toEqual([
      [two.id, "hidden"],
      [one.id, "active"],
    ]);
  });

  it("prunes tables whose source is gone and links whose document is gone", async () => {
    const { id, source: s } = await seed();
    const doc = await createDocument(A, "ann");
    const other = await createDocument(A, "ann");
    await linkTable(A, "ann", doc.id, id);
    await linkTable(A, "ann", other.id, id);
    await deleteDocument(A, other.id);
    expect((await getTable(A, id))!.document_ids).toEqual([doc.id]);

    await deleteSource(A, s.id);
    expect(await getTable(A, id)).toBeNull();
    expect(await listTables(A, { status: ["active", "hidden", "superseded"] })).toEqual([]);
    expect(await listDocumentTables(A, doc.id)).toEqual([]);
    expect(await linkTable(A, "ann", doc.id, id)).toBe("table_not_found");
  });

  it("filters by document, the document's sources, status and text", async () => {
    const s1 = await source(A, "Accounts 2025.xlsx");
    const s2 = await source(A, "Survey.csv");
    await replaceSourceTables(A, s1.id, "ann", [table("Income", "sheet:Income", { labels: ["Month", "Revenue"] }), table("Spend", "sheet:Spend")]);
    await replaceSourceTables(A, s2.id, "ann", [table("Counts", "csv", { labels: ["Week", "Walkers 50%_off"] })]);
    const id = async (name: string) => (await listTables(A)).find((t) => t.name === name)!.id;
    const doc = await createDocument(A, "ann");
    await linkSource(A, "ann", doc.id, s1.id);
    await linkTable(A, "ann", doc.id, await id("Counts"));

    // Newest first; within one read, in the order found.
    expect((await listTables(A)).map((t) => t.name)).toEqual(["Counts", "Income", "Spend"]);
    expect((await listTables(A, { forDocument: doc.id })).map((t) => t.name)).toEqual(["Income", "Spend"]);
    expect((await listTables(A, { documentId: doc.id })).map((t) => t.name)).toEqual(["Counts"]);
    expect((await listTables(A, { query: "revenue" })).map((t) => t.name)).toEqual(["Income"]);
    expect((await listTables(A, { query: "accounts 2025" })).map((t) => t.name)).toEqual(["Income", "Spend"]);
    expect((await listTables(A, { query: "survey" })).map((t) => t.name)).toEqual(["Counts"]);
    expect((await listTables(A, { query: "50%_" })).map((t) => t.name)).toEqual(["Counts"]);
    expect(await listTables(A, { query: "nothing like it" })).toEqual([]);
    expect((await listTables(A, { limit: 1 })).map((t) => t.name)).toEqual(["Counts"]);
    await patchTable(A, "ann", await id("Spend"), { op: "hide" });
    expect((await listTables(A, { sourceId: s1.id, status: ["hidden"] })).map((t) => t.name)).toEqual(["Spend"]);
    expect(await listTables(A, { sourceId: "nope" })).toEqual([]);
    expect(await listTables(B, { forDocument: doc.id })).toEqual([]);
  });

  it("pads ragged rows to the column count", async () => {
    const { id } = await seed(A, table("Ragged", "csv", { rows: [["only"], ["a", "b", "extra"]] }));
    expect((await getTableRows(A, id, 0, 5))!.map((r) => r.cells)).toEqual([
      ["only", null],
      ["a", "b"],
    ]);
  });
});
