import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { columnKey } from "@/lib/data/contract";
import { linkTable, listTables, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { createSource, linkSource, resetSourceStore } from "@/lib/sources/store";
import { applyGenerated } from "@/lib/suggestions/store";
import { PATCH } from "./route";

const patch = (id: string, suggestionId: string, body: unknown, raw?: string) =>
  PATCH(new Request("http://x", { method: "PATCH", body: raw ?? JSON.stringify(body) }), { params: Promise.resolve({ id, suggestionId }) });

/** A table of the team's, read from a new source. */
async function makeTable(teamId = "org:a") {
  const s = await createSource(teamId, "ann", { kind: "file", title: "Figures.csv" });
  await replaceSourceTables(teamId, s.id, "ann", [
    {
      match_key: "csv",
      name: "Figures",
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

describe("PATCH /api/documents/[id]/suggestions/[suggestionId]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
  });

  const setup = async () => {
    const d = await createDocument("org:a", "ann");
    const [source, data] = (await applyGenerated("org:a", "ann", d.id, "type", [
      { kind: "source", label: "Report", reason: "", spec_ref: null },
      { kind: "data", label: "Figures", reason: "", spec_ref: null },
    ]))!;
    return { d, source, data };
  };

  it("adds with a linked source, dismisses and restores", async () => {
    const { d, source, data } = await setup();
    const s = await createSource("org:a", "ann", { kind: "note", title: "Annual report" });
    await linkSource("org:a", "ann", d.id, s.id);
    const added = await patch(d.id, source.id, { action: "add", source_id: s.id });
    expect(added.status).toBe(200);
    expect((await added.json()).suggestion).toMatchObject({ state: "added", source_id: s.id });
    expect((await (await patch(d.id, source.id, { action: "restore" })).json()).suggestion).toMatchObject({ state: "open", source_id: null });
    expect((await (await patch(d.id, data.id, { action: "add" })).json()).suggestion).toMatchObject({ state: "added", source_id: null });
    expect((await (await patch(d.id, data.id, { action: "dismiss" })).json()).suggestion).toMatchObject({ state: "dismissed" });
  });

  it("400s bad bodies and sources that aren't linked to the document", async () => {
    const { d, source } = await setup();
    expect((await patch(d.id, source.id, { action: "maybe" })).status).toBe(400);
    expect((await patch(d.id, source.id, { action: "add", source_id: "not-a-uuid" })).status).toBe(400);
    const unlinked = await createSource("org:a", "ann", { kind: "note", title: "Loose" });
    const res = await patch(d.id, source.id, { action: "add", source_id: unlinked.id });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/linked/);
    expect((await patch(d.id, source.id, { action: "dismiss", source_id: unlinked.id })).status).toBe(400);
  });

  it("adds a data suggestion with a linked table, and dismiss forgets it", async () => {
    const { d, data } = await setup();
    const t = await makeTable();
    await linkTable("org:a", "ann", d.id, t);
    const added = await patch(d.id, data.id, { action: "add", data_table_id: t });
    expect(added.status).toBe(200);
    expect((await added.json()).suggestion).toMatchObject({ state: "added", data_table_id: t, source_id: null });
    expect((await (await patch(d.id, data.id, { action: "dismiss" })).json()).suggestion).toMatchObject({ state: "dismissed", data_table_id: null });
  });

  it("400s data_table_id off add, on a source suggestion, or for a table not linked to the document", async () => {
    const { d, source, data } = await setup();
    const t = await makeTable();
    const unlinked = await makeTable();
    await linkTable("org:a", "ann", d.id, t);
    expect((await patch(d.id, data.id, { action: "dismiss", data_table_id: t })).status).toBe(400);
    expect((await patch(d.id, source.id, { action: "add", data_table_id: t })).status).toBe(400);
    const res = await patch(d.id, data.id, { action: "add", data_table_id: unlinked });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That table isn't linked to this document." });
    const theirs = await makeTable("org:b");
    expect((await patch(d.id, data.id, { action: "add", data_table_id: theirs })).status).toBe(400);
    expect((await patch(d.id, data.id, { action: "add", data_table_id: "nope" })).status).toBe(400);
    expect((await patch(d.id, data.id, null, "{bad")).status).toBe(400);
  });

  it("404s unknown suggestions and foreign documents", async () => {
    const { d, source } = await setup();
    expect((await patch(d.id, "00000000-0000-4000-8000-000000000000", { action: "dismiss" })).status).toBe(404);
    expect((await patch(d.id, "nope", { action: "dismiss" })).status).toBe(404);
    const other = await createDocument("org:b", "bob");
    expect((await patch(other.id, source.id, { action: "dismiss" })).status).toBe(404);
    const mine = await createDocument("org:a", "ann");
    expect((await patch(mine.id, source.id, { action: "dismiss" })).status).toBe(404);
  });
});
