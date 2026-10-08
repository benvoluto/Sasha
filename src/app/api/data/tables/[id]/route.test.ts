import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ deny: null as Response | null, asked: [] as string[] }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => (team.asked.push(permission), team.deny ?? { teamId: "org:a", agent: "ann" }),
}));

import { columnKey } from "@/lib/data/contract";
import { listTables, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { GET, PATCH } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, qs = "") => GET(new Request(`http://x/api/data/tables/${id}${qs}`), ctx(id));
const patch = (id: string, body: unknown, raw?: string) =>
  PATCH(new Request(`http://x/api/data/tables/${id}`, { method: "PATCH", body: raw ?? JSON.stringify(body) }), ctx(id));

async function seed(team = "org:a", rows = 250) {
  const s = await createSource(team, "ann", { kind: "file", title: "Budget.csv" });
  await replaceSourceTables(team, s.id, "ann", [
    {
      match_key: "csv",
      name: "Budget",
      columns: [0, 1].map((i) => ({ key: columnKey(i), label: i ? "Cost" : "Item", type: "text" as const, inferred: "text" as const, unit: null })),
      rows: Array.from({ length: rows }, (_, i) => [`r${i}`, String(i)]),
      extraction_method: "csv",
      sheet: null,
      page: null,
      page_end: null,
      confidence: null,
      notes: "",
      truncated: false,
    },
  ]);
  return (await listTables(team, { sourceId: s.id }))[0].id;
}

describe("/api/data/tables/[id]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    team.deny = null;
    team.asked.length = 0;
  });

  it("GET pages rows with next_offset", async () => {
    const id = await seed();
    const first = await (await get(id)).json();
    expect(first).toMatchObject({ table: { id, row_count: 250 }, offset: 0, next_offset: 100 });
    expect(first.rows).toHaveLength(100);
    const last = await (await get(id, "?offset=200&limit=100")).json();
    expect(last.rows.map((r: { idx: number }) => r.idx)[0]).toBe(200);
    expect(last).toMatchObject({ offset: 200, next_offset: null });
    expect((await (await get(id, "?offset=900")).json())).toMatchObject({ rows: [], next_offset: null });
    expect(team.asked).toContain(PERMISSIONS.sourceRead);
  });

  it("GET 400s a bad page and 404s another team's or an unknown table", async () => {
    const id = await seed();
    expect((await get(id, "?limit=501")).status).toBe(400);
    expect((await get(id, "?offset=x")).status).toBe(400);
    expect((await get(id, "?other=1")).status).toBe(400);
    const theirs = await seed("org:b");
    expect((await get(theirs)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });

  it("PATCH applies a change and returns the changed row", async () => {
    const id = await seed();
    const res = await patch(id, { op: "override", row: 2, key: "c2", value: "=cmd" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ table: { override_count: 1 }, row: { idx: 2, cells: ["r2", "=cmd"], overrides: { c2: { original: "2", by: "ann" } } } });
    const renamed = await (await patch(id, { op: "rename", name: "Costs" })).json();
    expect(renamed.table.name).toBe("Costs");
    expect(renamed).not.toHaveProperty("row");
    expect(team.asked).toContain(PERMISSIONS.sourceWrite);
  });

  it("PATCH maps refusals to 400, 404 and 409", async () => {
    const id = await seed();
    expect((await patch(id, { op: "unhide" })).status).toBe(409);
    expect(await (await patch(id, { op: "restore" })).json()).toEqual({ error: "That change doesn't apply to this table." });
    expect((await patch(id, { op: "revert", row: 0, key: "c1" })).status).toBe(409);
    expect((await patch(id, { op: "supersede", by: id })).status).toBe(409);
    expect((await patch(id, { op: "override", row: 999, key: "c1", value: "x" })).status).toBe(400);
    expect((await patch(id, { op: "column", key: "c9", label: "x" })).status).toBe(400);
    const theirs = await seed("org:b");
    expect((await patch(theirs, { op: "hide" })).status).toBe(404);
    expect((await patch(id, { op: "supersede", by: theirs })).status).toBe(409);
  });

  it("PATCH 400s bad bodies and invalid JSON", async () => {
    const id = await seed();
    expect((await patch(id, { op: "explode" })).status).toBe(400);
    expect((await patch(id, { op: "rename", name: "" })).status).toBe(400);
    expect((await patch(id, null, "{not json")).status).toBe(400);
    expect((await patch(id, null, "")).status).toBe(400);
  });

  it("passes through 401 and 403", async () => {
    const id = await seed();
    team.deny = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    expect((await get(id)).status).toBe(401);
    team.deny = NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    expect((await patch(id, { op: "hide" })).status).toBe(403);
  });
});
