import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ deny: null as Response | null }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => team.deny ?? { teamId: "org:a", agent: "ann" } }));

import { columnKey } from "@/lib/data/contract";
import { listTables, patchTable, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { resetMemoryStore } from "@/lib/documents/store";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { GET } from "./route";

const get = (id: string) => GET(new Request(`http://x/api/data/tables/${id}/csv`), { params: Promise.resolve({ id }) });

async function seed(teamId: string, name: string) {
  const s = await createSource(teamId, "ann", { kind: "file", title: "f.csv" });
  await replaceSourceTables(teamId, s.id, "ann", [
    {
      match_key: "csv",
      name,
      columns: [0, 1].map((i) => ({ key: columnKey(i), label: i ? "Cost, £" : "Item", type: "text" as const, inferred: "text" as const, unit: null })),
      rows: [
        ["=cmd|' /C calc'!A0", "-12.5"],
        ["Rent", "100"],
        ["Power", null],
      ],
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

describe("GET /api/data/tables/[id]/csv", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    team.deny = null;
  });

  it("downloads every row, formula-safe, overrides applied, with safe headers and a BOM", async () => {
    const id = await seed("org:a", 'Budget "Q1" / 2026 – €');
    await patchTable("org:a", "ann", id, { op: "override", row: 1, key: "c2", value: "@SUM(A1)" });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cd = res.headers.get("content-disposition")!;
    expect(cd).toMatch(/^attachment; filename="Budget _Q1_ 2026 _ _\.csv"; filename\*=UTF-8''/);
    expect(cd).toContain(encodeURIComponent("Budget \"Q1\" 2026 – €.csv"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe(`Item,"Cost, £"\r\n'=cmd|' /C calc'!A0,-12.5\r\nRent,'@SUM(A1)\r\nPower,\r\n`);
  });

  it("404s another team's table and passes through 401", async () => {
    const theirs = await seed("org:b", "Theirs");
    expect((await get(theirs)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
    team.deny = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    expect((await get(theirs)).status).toBe(401);
  });
});
