import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The other store tests run on the in-memory fallback; these check the SQL the
// data store builds (placeholders, team scoping, ILIKE escaping, batched row
// inserts, the re-read's supersede and relink).
type Call = { text: string; params: unknown[] };
const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (() => ({ rows: [] })) as (c: Call) => { rows: Record<string, unknown>[]; rowCount?: number },
}));
vi.mock("@vercel/postgres", () => {
  const run = async (text: string, params: unknown[]) => {
    const call = { text: text.replace(/\s+/g, " ").trim(), params };
    mocks.calls.push(call);
    const r = mocks.respond(call);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => run(strings.reduce((a, s, i) => a + `$${i}` + s), values);
  return { sql: Object.assign(sql, { query: (text: string, params: unknown[] = []) => run(text, params) }) };
});
vi.mock("@/lib/ontology/ensure-schema", () => ({ ensureSchema: async () => {} }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));
vi.mock("@/lib/documents/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/store")>()),
  getDocument: async (_t: string, id: string) => ({ id }),
}));
vi.mock("@/lib/sources/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sources/store")>()),
  getSource: async (_t: string, id: string) => ({ id, title: "S", filename: null, kind: "file", mime: null }),
}));

import { columnKey, type ExtractedTable } from "./contract";
import { getTableRows, listDocumentTables, listTables, replaceSourceTables, ROW_INSERT_BATCH } from "./store";

const SRC = "0b6f1c1e-7a5d-4c39-9a0e-2f4f3d1b8c11";
const DOC = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";
const OLD = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";

const tableRow = (over: Record<string, unknown> = {}) => ({
  id: T1,
  team_id: "org:a",
  source_id: SRC,
  idx: 0,
  match_key: "csv",
  name: "Budget",
  columns: [
    { key: "c1", label: "Item", type: "text", inferred: "text", unit: null },
    { key: "c2", label: "Cost", type: "number", inferred: "number", unit: null },
  ],
  row_count: 3,
  status: "active",
  superseded_by: null,
  extraction_method: "csv",
  sheet: null,
  page: null,
  page_end: null,
  confidence: null,
  notes: "",
  truncated: false,
  created_by: "ann",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  source_title: "Budget.csv",
  source_filename: "Budget.csv",
  source_kind: "file",
  source_mime: "text/csv",
  document_ids: [DOC],
  override_count: 1,
  ...over,
});

const extracted = (rows: number): ExtractedTable => ({
  match_key: "csv",
  name: "Budget",
  columns: [0, 1].map((i) => ({ key: columnKey(i), label: `L${i}`, type: "text", inferred: "text", unit: null })),
  rows: Array.from({ length: rows }, (_, i) => [`r${i}`, "x"]),
  extraction_method: "csv",
  sheet: null,
  page: null,
  page_end: null,
  confidence: null,
  notes: "",
  truncated: false,
});

describe("data store SQL", () => {
  beforeEach(() => {
    process.env.POSTGRES_URL = "postgres://test";
    mocks.calls.length = 0;
    mocks.respond = () => ({ rows: [] });
  });
  afterEach(() => {
    delete process.env.POSTGRES_URL;
  });

  it("numbers listTables placeholders in order, scopes to the team and escapes the search", async () => {
    await listTables("org:a", { sourceId: SRC, documentId: DOC, forDocument: DOC, status: ["active", "hidden"], query: "50%_off\\", limit: 10 });
    const [{ text, params }] = mocks.calls;
    expect(text).toContain("FROM data_table t JOIN source s ON s.id = t.source_id AND s.team_id = t.team_id");
    expect(text).toContain("WHERE t.team_id = $1 AND t.status = ANY($2::text[]) AND t.source_id = $3::uuid");
    expect(text).toContain("dd.document_id = $4::uuid");
    expect(text).toContain("ds.document_id = $5::uuid");
    expect(text).toContain("t.name ILIKE $6 OR s.title ILIKE $6 OR s.filename ILIKE $6");
    expect(text).toContain("jsonb_array_elements(t.columns) c WHERE c->>'label' ILIKE $6");
    expect(text).toContain("ARRAY(SELECT dd.document_id::text FROM document_data dd WHERE dd.table_id = t.id ORDER BY dd.added_at) AS document_ids");
    expect(text).toContain("(SELECT COUNT(*)::int FROM data_cell_override o WHERE o.table_id = t.id) AS override_count");
    expect(text).toMatch(/ORDER BY t.created_at DESC, t.idx LIMIT \$7$/);
    expect(params).toEqual(["org:a", ["active", "hidden"], SRC, DOC, DOC, "%50\\%\\_off\\\\%", 10]);
  });

  it("defaults to active tables, caps the limit at 200, and skips the query for bad ids", async () => {
    await listTables("org:a", { limit: 5000 });
    expect(mocks.calls[0].params).toEqual(["org:a", ["active"], 200]);
    expect(await listTables("org:a", { forDocument: "nope" })).toEqual([]);
    expect(mocks.calls).toHaveLength(1);
  });

  it("maps joined rows to summaries", async () => {
    mocks.respond = () => ({ rows: [tableRow()] });
    const [t] = await listTables("org:a");
    expect(t).toMatchObject({ id: T1, source: { id: SRC, title: "Budget.csv", kind: "file", mime: "text/csv" }, document_ids: [DOC], override_count: 1, row_count: 3 });
    expect(t).not.toHaveProperty("team_id");
    expect(t).not.toHaveProperty("match_key");
  });

  it("lists a document's tables through document_data, scoped to the team twice", async () => {
    mocks.respond = (c) => (c.text.includes("FROM document_data l") ? { rows: [{ ...tableRow(), link_added_by: "ann", link_added_at: "2026-01-02T00:00:00Z" }] } : { rows: [] });
    const [t] = (await listDocumentTables("org:a", DOC))!;
    const call = mocks.calls.find((c) => c.text.includes("FROM document_data l"))!;
    expect(call.text).toContain("WHERE l.document_id = $1 AND l.team_id = $2 AND t.team_id = $2 ORDER BY l.added_at");
    expect(t).toMatchObject({ id: T1, added_by: "ann", added_at: "2026-01-02T00:00:00.000Z" });
  });

  it("applies overrides to a page of rows", async () => {
    mocks.respond = (c) => {
      if (c.text.includes("FROM data_table t")) return { rows: [tableRow()] };
      if (c.text.startsWith("SELECT idx, cells")) return { rows: [{ idx: 1, cells: ["Power", "40"] }, { idx: 2, cells: ["Water"] }] };
      if (c.text.startsWith("SELECT row_idx")) return { rows: [{ row_idx: 1, col_key: "c2", value: "45", original: "40", created_by: "bea", created_at: "2026-01-03T00:00:00Z" }] };
      return { rows: [] };
    };
    const rows = (await getTableRows("org:a", T1, 1, 2))!;
    expect(rows).toEqual([
      { idx: 1, cells: ["Power", "45"], overrides: { c2: { original: "40", by: "bea", at: "2026-01-03T00:00:00.000Z" } } },
      { idx: 2, cells: ["Water", null] },
    ]);
    const page = mocks.calls.find((c) => c.text.includes("FROM data_row"))!;
    expect(page.text).toContain("WHERE table_id = $1 AND idx >= $2 ORDER BY idx LIMIT $3");
    expect(page.params).toEqual([T1, 1, 2]);
    expect(mocks.calls.find((c) => c.text.startsWith("SELECT row_idx"))!.params).toEqual([T1, 1, 3]);
  });

  it("re-reads a source: batched row inserts, team-scoped supersede, and links moved to the matching table", async () => {
    mocks.respond = (c) => {
      if (c.text.startsWith("SELECT id, match_key, status, page FROM data_table")) return { rows: [{ id: OLD, match_key: "csv", status: "hidden", page: null }] };
      if (c.text.startsWith("DELETE FROM document_data")) return { rows: [{ document_id: DOC }] };
      return { rows: [] };
    };
    const n = ROW_INSERT_BATCH * 2 + 5;
    expect(await replaceSourceTables("org:a", SRC, "ingest", [extracted(n)])).toEqual({ inserted: 1, superseded: 1 });

    const current = mocks.calls.find((c) => c.text.startsWith("SELECT id, match_key, status, page FROM data_table"))!;
    expect(current.text).toContain("WHERE team_id = $1 AND source_id = $2 AND status IN ('active', 'hidden')");

    const insert = mocks.calls.find((c) => c.text.startsWith("INSERT INTO data_table"))!;
    const newId = insert.params[0] as string;
    // Inherits hidden from the table it replaces.
    expect(insert.params.slice(1, 9)).toEqual(["org:a", SRC, 0, "csv", "Budget", expect.any(String), n, "hidden"]);

    const batches = mocks.calls.filter((c) => c.text.startsWith("INSERT INTO data_row"));
    expect(batches).toHaveLength(3);
    expect(batches[0].text).toBe("INSERT INTO data_row (table_id, idx, cells) SELECT $1::uuid, u.i, u.c::jsonb FROM unnest($2::int[], $3::text[]) AS u(i, c)");
    expect((batches[0].params[1] as number[]).length).toBe(ROW_INSERT_BATCH);
    expect((batches[2].params[1] as number[])[0]).toBe(ROW_INSERT_BATCH * 2);
    expect(JSON.parse((batches[2].params[2] as string[])[4])).toEqual([`r${n - 1}`, "x"]);

    const supersede = mocks.calls.find((c) => c.text.startsWith("UPDATE data_table SET status = 'superseded'"))!;
    expect(supersede.text).toContain("WHERE team_id = $1 AND id = ANY($2::uuid[]) AND status IN ('active', 'hidden')");
    expect(supersede.params).toEqual(["org:a", [OLD]]);
    // Inserted before the old ones are superseded.
    expect(mocks.calls.indexOf(insert)).toBeLessThan(mocks.calls.indexOf(supersede));

    const pointer = mocks.calls.find((c) => c.text.startsWith("UPDATE data_table SET superseded_by"))!;
    expect(pointer.params).toEqual([newId, OLD, "org:a"]);
    const copy = mocks.calls.find((c) => c.text.startsWith("INSERT INTO document_data"))!;
    expect(copy.text).toContain("SELECT document_id, $1, team_id, added_by, added_at FROM document_data WHERE table_id = $2 AND team_id = $3 ON CONFLICT (document_id, table_id) DO NOTHING");
    expect(copy.params).toEqual([newId, OLD, "org:a"]);
    const del = mocks.calls.find((c) => c.text.startsWith("DELETE FROM document_data"))!;
    expect(mocks.calls.indexOf(copy)).toBeLessThan(mocks.calls.indexOf(del));
  });

  it("removes a partly written table when a row batch fails, and supersedes nothing", async () => {
    let batches = 0;
    mocks.respond = (c) => {
      if (c.text.startsWith("SELECT id, match_key, status, page FROM data_table")) return { rows: [{ id: OLD, match_key: "csv", status: "active", page: null }] };
      if (c.text.startsWith("INSERT INTO data_row") && ++batches === 2) throw new Error("unsupported Unicode escape sequence");
      return { rows: [] };
    };
    await expect(replaceSourceTables("org:a", SRC, "ingest", [extracted(ROW_INSERT_BATCH * 2)])).rejects.toThrow("unsupported Unicode");

    const newId = mocks.calls.find((c) => c.text.startsWith("INSERT INTO data_table"))!.params[0];
    const removed = mocks.calls.find((c) => c.text.startsWith("DELETE FROM data_table"))!;
    expect(removed.text).toBe("DELETE FROM data_table WHERE team_id = $1 AND id = ANY($2::uuid[])");
    expect(removed.params).toEqual(["org:a", [newId]]);
    expect(mocks.calls.some((c) => c.text.startsWith("UPDATE data_table SET status = 'superseded'"))).toBe(false);
  });
});
