import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ deny: null as Response | null, asked: [] as string[] }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => (team.asked.push(permission), team.deny ?? { teamId: "org:a", agent: "ann" }),
}));

import { columnKey } from "@/lib/data/contract";
import { linkTable, listDocumentTables, listTables, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { DELETE } from "./route";

const del = (id: string, tableId: string) => DELETE(new Request(`http://x/api/documents/${id}/data/${tableId}`, { method: "DELETE" }), { params: Promise.resolve({ id, tableId }) });

async function seed(teamId = "org:a") {
  const s = await createSource(teamId, "ann", { kind: "file", title: "t.csv" });
  await replaceSourceTables(teamId, s.id, "ann", [
    {
      match_key: "csv",
      name: "T",
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

describe("DELETE /api/documents/[id]/data/[tableId]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    team.deny = null;
    team.asked.length = 0;
  });

  it("unlinks, then 404s once it isn't linked", async () => {
    const doc = await createDocument("org:a", "ann");
    const id = await seed();
    await linkTable("org:a", "ann", doc.id, id);
    const res = await del(doc.id, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await listDocumentTables("org:a", doc.id)).toEqual([]);
    // The table stays in the library.
    expect(await listTables("org:a")).toHaveLength(1);
    expect(team.asked).toEqual([PERMISSIONS.documentWrite]);
    const again = await del(doc.id, id);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "That table isn't linked to this document." });
  });

  it("404s another team's document or table", async () => {
    const theirDoc = await createDocument("org:b", "bob");
    const theirs = await seed("org:b");
    await linkTable("org:b", "bob", theirDoc.id, theirs);
    expect((await del(theirDoc.id, theirs)).status).toBe(404);
    expect((await listDocumentTables("org:b", theirDoc.id))!.map((t) => t.id)).toEqual([theirs]);
    expect((await del("nope", "nope")).status).toBe(404);
  });

  it("passes through 401 and 403", async () => {
    team.deny = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    expect((await del(crypto.randomUUID(), crypto.randomUUID())).status).toBe(401);
    team.deny = NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    expect((await del(crypto.randomUUID(), crypto.randomUUID())).status).toBe(403);
  });
});
