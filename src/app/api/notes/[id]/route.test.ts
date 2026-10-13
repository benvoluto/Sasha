import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { getDocument, listDocumentNotes, resetMemoryStore } from "@/lib/documents/store";
import { createNote, getNote } from "@/lib/notes/store";
import { DELETE, GET, PATCH } from "./route";
import { POST as START } from "./start-document/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request(`http://x/api/notes/${id}`), ctx(id));
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/notes/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(id));
const del = (id: string) => DELETE(new Request(`http://x/api/notes/${id}`, { method: "DELETE" }), ctx(id));
const start = (id: string) => START(new Request(`http://x/api/notes/${id}/start-document`, { method: "POST" }), ctx(id));
const GHOST = "00000000-0000-4000-8000-000000000000";

describe("/api/notes/[id]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("gets a note, and 404s an unknown or another team's note", async () => {
    const n = await createNote("org:a", "ann", "Mine");
    expect(await (await get(n.id)).json()).toEqual({ note: n });
    const theirs = await createNote("org:b", "zed", "Theirs");
    for (const id of [theirs.id, GHOST, "nope"]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Note not found." });
    }
  });

  it("saves with a base, and answers a stale base with 409 and the current note", async () => {
    const n = await createNote("org:a", "ann", "v1");
    const ok = await patch(n.id, { body: "v2", base_updated_at: n.updated_at });
    expect(ok.status).toBe(200);
    const saved = (await ok.json()).note;
    expect(saved.body).toBe("v2");

    const stale = await patch(n.id, { body: "v3", base_updated_at: n.updated_at });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "Someone else changed this note.", code: "conflict", note: saved });

    // "Keep mine" saves without a base.
    expect((await (await patch(n.id, { body: "v3" })).json()).note.body).toBe("v3");
  });

  it("400s invalid changes and 404s an unknown note", async () => {
    const n = await createNote("org:a", "ann", "keep");
    expect((await patch(n.id, "{not json")).status).toBe(400);
    expect((await patch(n.id, {})).status).toBe(400);
    expect((await patch(n.id, { body: "x".repeat(200_001) })).status).toBe(400);
    expect((await getNote("org:a", n.id))?.body).toBe("keep");
    expect((await patch(GHOST, { body: "x" })).status).toBe(404);
  });

  it("deletes", async () => {
    const n = await createNote("org:a", "ann", "bye");
    const res = await del(n.id);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await getNote("org:a", n.id)).toBeNull();
    expect((await del(n.id)).status).toBe(404);
  });
});

describe("POST /api/notes/[id]/start-document", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("moves the note into a new document's notes and deletes the note", async () => {
    const n = await createNote("org:a", "ann", "\nTrip plan\nKyoto first");
    const res = await start(n.id);
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document).toEqual({ id: expect.any(String), title: "Trip plan" });
    expect(await getDocument("org:a", document.id)).toMatchObject({ title: "Trip plan", notes: "\nTrip plan\nKyoto first", type_key: null, created_by: "ann" });
    expect(await getNote("org:a", n.id)).toBeNull();
    expect((await listDocumentNotes("org:a")).map((d) => d.id)).toEqual([document.id]);
  });

  it("404s an unknown or another team's note", async () => {
    const theirs = await createNote("org:b", "zed", "Theirs");
    expect((await start(theirs.id)).status).toBe(404);
    expect((await start(GHOST)).status).toBe(404);
    expect(await getNote("org:b", theirs.id)).not.toBeNull();
  });
});
