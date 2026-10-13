import { beforeEach, describe, expect, it } from "vitest";
import { resetMemoryStore } from "@/lib/documents/store";
import { MAX_NOTE_BODY } from "./contract";
import { createNote, deleteNote, getNote, listNotes, restoreNote, takeNote, updateNote } from "./store";

describe("notes store (in memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("creates, reads and lists notes newest first", async () => {
    const a = await createNote("t", "ann", "First\nmore");
    const b = await createNote("t", "bob");
    expect(a).toMatchObject({ body: "First\nmore", created_by: "ann", updated_by: "ann" });
    expect(b.body).toBe("");
    expect(await getNote("t", a.id)).toEqual(a);
    expect(await getNote("t", a.id.toUpperCase())).toEqual(a);
    expect((await listNotes("t")).map((n) => n.id)).toEqual([b.id, a.id]);
    expect(await listNotes("t", { limit: 1 })).toHaveLength(1);
    expect(await getNote("t", "nope")).toBeNull();
  });

  it("caps the body", async () => {
    const n = await createNote("t", "ann", "x".repeat(MAX_NOTE_BODY + 5));
    expect(n.body).toHaveLength(MAX_NOTE_BODY);
  });

  it("searches the body ignoring case", async () => {
    const a = await createNote("t", "ann", "Riverside budget");
    await createNote("t", "ann", "Other");
    expect((await listNotes("t", { query: "RIVERSIDE" })).map((n) => n.id)).toEqual([a.id]);
    expect(await listNotes("t", { query: "zzz" })).toEqual([]);
  });

  it("scopes notes to a team", async () => {
    const n = await createNote("org:a", "ann", "Ours");
    expect(await getNote("org:b", n.id)).toBeNull();
    expect(await listNotes("org:b")).toEqual([]);
    expect(await updateNote("org:b", n.id, "zed", "Theirs")).toBeNull();
    expect(await deleteNote("org:b", n.id)).toBe(false);
    expect((await getNote("org:a", n.id))?.body).toBe("Ours");
  });

  it("saves, refuses a stale base with the current note, and saves without a base", async () => {
    const n = await createNote("t", "ann", "v1");
    const first = await updateNote("t", n.id, "ann", "v2", n.updated_at);
    expect(first).toMatchObject({ ok: true, note: { body: "v2", updated_by: "ann" } });
    if (!first?.ok) return;
    expect(first.note.updated_at > n.updated_at).toBe(true);

    const stale = await updateNote("t", n.id, "bob", "bob's", n.updated_at);
    expect(stale).toEqual({ ok: false, conflict: first.note });

    const forced = await updateNote("t", n.id, "bob", "bob's");
    expect(forced).toMatchObject({ ok: true, note: { body: "bob's", updated_by: "bob" } });
    expect(await updateNote("t", "00000000-0000-4000-8000-000000000000", "ann", "x")).toBeNull();
  });

  it("deletes", async () => {
    const n = await createNote("t", "ann", "bye");
    expect(await deleteNote("t", n.id)).toBe(true);
    expect(await getNote("t", n.id)).toBeNull();
    expect(await deleteNote("t", n.id)).toBe(false);
    expect(await deleteNote("t", "nope")).toBe(false);
  });

  it("clears with the documents store", async () => {
    await createNote("t", "ann", "x");
    resetMemoryStore();
    expect(await listNotes("t")).toEqual([]);
  });

  it("takes a note once, for its own team only, and restores it unchanged", async () => {
    const n = await createNote("t", "ann", "Once");
    expect(await takeNote("org:b", n.id)).toBeNull();
    const [first, second] = await Promise.all([takeNote("t", n.id), takeNote("t", n.id)]);
    expect(first).toEqual(n);
    expect(second).toBeNull();
    expect(await getNote("t", n.id)).toBeNull();
    await restoreNote("t", n);
    expect(await getNote("t", n.id)).toEqual(n);
    expect(await takeNote("t", "nope")).toBeNull();
  });
});
