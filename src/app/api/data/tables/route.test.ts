import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ deny: null as Response | null, asked: [] as string[], teamId: "org:a" }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => (team.asked.push(permission), team.deny ?? { teamId: team.teamId, agent: "ann" }),
}));

import { columnKey } from "@/lib/data/contract";
import { replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { createSource, linkSource, resetSourceStore } from "@/lib/sources/store";
import { GET } from "./route";

const get = (qs = "") => GET(new Request(`http://x/api/data/tables${qs}`));
const table = (name: string, match_key: string) => ({
  match_key,
  name,
  columns: [0, 1].map((i) => ({ key: columnKey(i), label: i ? "Cost" : "Item", type: "text" as const, inferred: "text" as const, unit: null })),
  rows: [["a", "1"]],
  extraction_method: "csv" as const,
  sheet: null,
  page: null,
  page_end: null,
  confidence: null,
  notes: "",
  truncated: false,
});

describe("GET /api/data/tables", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    team.deny = null;
    team.asked.length = 0;
    team.teamId = "org:a";
  });

  it("lists the team's tables with filters", async () => {
    const s = await createSource("org:a", "ann", { kind: "file", title: "Budget.csv" });
    const other = await createSource("org:a", "ann", { kind: "file", title: "Other.csv" });
    await replaceSourceTables("org:a", s.id, "ann", [table("Budget", "csv")]);
    await replaceSourceTables("org:a", other.id, "ann", [table("Other", "csv")]);
    const theirs = await createSource("org:b", "bob", { kind: "file", title: "Theirs.csv" });
    await replaceSourceTables("org:b", theirs.id, "bob", [table("Theirs", "csv")]);
    const doc = await createDocument("org:a", "ann");
    await linkSource("org:a", "ann", doc.id, s.id);

    const all = await get();
    expect(all.status).toBe(200);
    expect((await all.json()).tables.map((t: { name: string }) => t.name)).toEqual(["Other", "Budget"]);
    expect(team.asked).toEqual([PERMISSIONS.sourceRead]);
    expect((await (await get(`?for_document=${doc.id}`)).json()).tables.map((t: { name: string }) => t.name)).toEqual(["Budget"]);
    expect((await (await get(`?source_id=${other.id}&status=active,hidden`)).json()).tables.map((t: { name: string }) => t.name)).toEqual(["Other"]);
    expect((await (await get("?q=budg")).json()).tables.map((t: { name: string }) => t.name)).toEqual(["Budget"]);
    expect((await (await get("?status=superseded")).json()).tables).toEqual([]);
  });

  it("400s a bad query", async () => {
    for (const qs of ["?status=deleted", "?source_id=nope", "?unknown=1", `?q=${"x".repeat(201)}`]) {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  it("passes through 401 and 403", async () => {
    team.deny = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    expect((await get()).status).toBe(401);
    team.deny = NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    expect((await get()).status).toBe(403);
  });
});
