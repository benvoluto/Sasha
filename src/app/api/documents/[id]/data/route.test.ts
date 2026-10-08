import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ deny: null as Response | null, asked: [] as string[] }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => (team.asked.push(permission), team.deny ?? { teamId: "org:a", agent: "ann" }),
}));

import { columnKey } from "@/lib/data/contract";
import { listTables, patchTable, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { GET, POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request(`http://x/api/documents/${id}/data`), ctx(id));
const post = (id: string, body: unknown, raw?: string) => POST(new Request(`http://x/api/documents/${id}/data`, { method: "POST", body: raw ?? JSON.stringify(body) }), ctx(id));

async function seed(teamId = "org:a", name = "Budget") {
  const s = await createSource(teamId, "ann", { kind: "file", title: `${name}.csv` });
  await replaceSourceTables(teamId, s.id, "ann", [
    {
      match_key: "csv",
      name,
      columns: [0, 1].map((i) => ({ key: columnKey(i), label: `L${i}`, type: "text" as const, inferred: "text" as const, unit: null })),
      rows: [["a", "1"]],
      extraction_method: "csv",
      sheet: null,
      page: null,
      page_end: null,
      confidence: null,
      notes: "",
      truncated: false,
    },
  ]);
  return (await listTables(teamId, { sourceId: s.id }))[0].id;
}

describe("/api/documents/[id]/data", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    team.deny = null;
    team.asked.length = 0;
  });

  it("links tables idempotently and lists them oldest first in any status", async () => {
    const doc = await createDocument("org:a", "ann");
    const one = await seed("org:a", "One");
    const two = await seed("org:a", "Two");
    const res = await post(doc.id, { table_id: two });
    expect(res.status).toBe(200);
    expect((await res.json()).table).toMatchObject({ id: two, name: "Two", added_by: "ann", document_ids: [doc.id] });
    expect((await post(doc.id, { table_id: two })).status).toBe(200);
    await post(doc.id, { table_id: one });
    await patchTable("org:a", "ann", two, { op: "hide" });
    const list = await get(doc.id);
    expect(list.status).toBe(200);
    expect((await list.json()).tables.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
      [two, "hidden"],
      [one, "active"],
    ]);
    expect(team.asked).toEqual([PERMISSIONS.documentWrite, PERMISSIONS.documentWrite, PERMISSIONS.documentWrite, PERMISSIONS.documentRead]);
  });

  it("404s a missing or another team's document or table", async () => {
    const doc = await createDocument("org:a", "ann");
    const theirDoc = await createDocument("org:b", "bob");
    const theirs = await seed("org:b");
    const mine = await seed();
    expect((await get(theirDoc.id)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
    expect(await (await post(theirDoc.id, { table_id: mine })).json()).toEqual({ error: "Document not found." });
    const res = await post(doc.id, { table_id: theirs });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Table not found." });
  });

  it("400s bad bodies and invalid JSON", async () => {
    const doc = await createDocument("org:a", "ann");
    expect((await post(doc.id, { table_id: "nope" })).status).toBe(400);
    expect((await post(doc.id, { table_id: crypto.randomUUID(), extra: 1 })).status).toBe(400);
    expect((await post(doc.id, null, "{oops")).status).toBe(400);
  });

  it("passes through 401 and 403", async () => {
    const doc = await createDocument("org:a", "ann");
    team.deny = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    expect((await get(doc.id)).status).toBe(401);
    team.deny = NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    expect((await post(doc.id, { table_id: crypto.randomUUID() })).status).toBe(403);
  });
});
