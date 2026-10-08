import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { createSource, linkSource, resetSourceStore } from "@/lib/sources/store";
import { applyGenerated } from "@/lib/suggestions/store";
import { PATCH } from "./route";

const patch = (id: string, suggestionId: string, body: unknown) =>
  PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id, suggestionId }) });

describe("PATCH /api/documents/[id]/suggestions/[suggestionId]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
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
