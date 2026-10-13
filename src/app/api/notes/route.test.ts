import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { NOTES_FEED_LIMIT, type NotesFeedItem } from "@/lib/notes/contract";
import { notesFeed } from "@/lib/notes/feed";
import { createNote, getNote } from "@/lib/notes/store";
import { GET, POST } from "./route";

const post = (body: unknown) => POST(new Request("http://x/api/notes", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const feed = async (qs = "") => ((await (await GET(new Request(`http://x/api/notes${qs}`))).json()).items as NotesFeedItem[]);

describe("GET /api/notes", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("merges notes and documents' notes, newest first", async () => {
    const n1 = await createNote("org:a", "ann", "Groceries\nmilk, eggs");
    const d = await createDocument("org:a", "ann", { title: "Grant", notes: "Budget\nask for 50k" });
    await createDocument("org:a", "ann", { title: "No notes" });
    await createNote("org:b", "zed", "Theirs");
    const n2 = await createNote("org:a", "ann", "");

    expect(await feed()).toEqual([
      { kind: "note", id: n2.id, title: "", excerpt: "", updated_at: n2.updated_at, created_by: "ann" },
      { kind: "document", document_id: d.id, document_title: "Grant", type_key: null, title: "Budget", excerpt: "ask for 50k", updated_at: d.updated_at },
      { kind: "note", id: n1.id, title: "Groceries", excerpt: "milk, eggs", updated_at: n1.updated_at, created_by: "ann" },
    ]);

    // An edit moves the document to the top; archiving hides it.
    await updateDocument("org:a", d.id, "ann", { notes: "Budget v2" });
    expect((await feed())[0]).toMatchObject({ kind: "document", title: "Budget v2" });
    await updateDocument("org:a", d.id, "ann", { archived: true });
    expect((await feed()).some((i) => i.kind === "document")).toBe(false);
  });

  it("filters by q across note bodies, document notes and titles", async () => {
    const n = await createNote("org:a", "ann", "Riverside trip");
    const d = await createDocument("org:a", "ann", { title: "Riverside grant", notes: "other words" });
    await createNote("org:a", "ann", "unrelated");
    const items = await feed("?q=riverside");
    expect(items.map((i) => (i.kind === "note" ? i.id : i.document_id)).sort()).toEqual([n.id, d.id].sort());
  });

  it("caps the merged feed", () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const notes = Array.from({ length: NOTES_FEED_LIMIT }, (_, i) => ({ id: `n${i}`, body: "", created_by: "a", updated_by: "a", created_at: at(i), updated_at: at(i) }));
    const docs = [{ id: "d", title: "", type_key: null, notes: "x", updated_at: at(NOTES_FEED_LIMIT) }];
    const items = notesFeed(notes, docs);
    expect(items).toHaveLength(NOTES_FEED_LIMIT);
    expect(items[0]).toMatchObject({ kind: "document", document_id: "d" });
  });
});

describe("POST /api/notes", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("creates an empty note by default, or with a body", async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    const { note } = await res.json();
    expect(note).toMatchObject({ body: "", created_by: "ann" });
    expect(await getNote("org:a", note.id)).toEqual(note);
    expect((await (await post({ body: "Hi" })).json()).note.body).toBe("Hi");
  });

  it("400s an invalid body", async () => {
    const res = await post({ body: 3 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid note." });
    expect((await post({ body: "x".repeat(200_001) })).status).toBe(400);
  });
});
