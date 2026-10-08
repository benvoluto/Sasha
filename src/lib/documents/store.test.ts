import { beforeEach, describe, expect, it } from "vitest";
import { createDocFolder } from "./folder-store";
import { bulkDocuments, createDocument, deleteDocument, getDocument, listDocuments, listVersions, resetMemoryStore, snapshotVersion, updateDocument } from "./store";

const body = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("document store (in memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("scopes documents to a team", async () => {
    const d = await createDocument("org:a", "ann", { title: "Plan" });
    expect(await getDocument("org:a", d.id)).not.toBeNull();
    expect(await getDocument("org:b", d.id)).toBeNull();
    expect(await listDocuments("org:b")).toHaveLength(0);
  });

  it("saves, searches and refuses stale saves", async () => {
    const d = await createDocument("t", "ann");
    const first = await updateDocument("t", d.id, "ann", { content_json: body("Riverside budget") }, d.updated_at);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.doc.content_text).toBe("Riverside budget");
    expect((await listDocuments("t", { query: "riverside" })).map((x) => x.id)).toEqual([d.id]);

    const stale = await updateDocument("t", d.id, "bob", { title: "Bob's" }, d.updated_at);
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });

    const forced = await updateDocument("t", d.id, "bob", { title: "Bob's" });
    expect(forced.ok).toBe(true);
  });

  it("archiving or restoring doesn't conflict with an editor's pending save", async () => {
    const d = await createDocument("t", "ann", { content_json: body("v1") });
    // The editor holds d.updated_at; the switcher archives, then the editor's
    // unmount flush saves with that base.
    const archived = await updateDocument("t", d.id, "ann", { archived: true });
    expect(archived).toMatchObject({ ok: true, doc: { archived: true, updated_at: d.updated_at, updated_by: d.updated_by } });
    const saved = await updateDocument("t", d.id, "ann", { content_json: body("last words") }, d.updated_at);
    expect(saved).toMatchObject({ ok: true, doc: { archived: true } });
    if (!saved.ok) return;

    // Restoring with the editor still open: its next autosave isn't a conflict.
    await updateDocument("t", d.id, "ann", { archived: false });
    const next = await updateDocument("t", d.id, "ann", { title: "Kept" }, saved.doc.updated_at);
    expect(next).toMatchObject({ ok: true, doc: { archived: false, title: "Kept" } });

    // Any real edit alongside the flag still counts as an edit.
    const both = await updateDocument("t", d.id, "bob", { archived: true, title: "Both" });
    expect(both.ok && both.doc.updated_by).toBe("bob");
  });

  it("archives, snapshots and deletes", async () => {
    const d = await createDocument("t", "ann", { content_json: body("v1") });
    await snapshotVersion("t", d.id, "ann", "before rewrite");
    expect((await listVersions("t", d.id)).map((v) => v.reason)).toEqual(["before rewrite"]);
    await updateDocument("t", d.id, "ann", { archived: true });
    expect(await listDocuments("t")).toHaveLength(0);
    expect(await listDocuments("t", { archived: true })).toHaveLength(1);
    expect(await deleteDocument("t", d.id)).toBe(true);
    expect(await getDocument("t", d.id)).toBeNull();
  });

  it("filters by document folder: root, one folder, or every folder", async () => {
    const f = await createDocFolder("t", "ann", "Grants");
    if (!f.ok) throw new Error("folder");
    const top = await createDocument("t", "ann", { title: "Top" });
    const inside = await createDocument("t", "ann", { title: "Inside" });
    expect(top.doc_folder_id).toBeNull();
    await updateDocument("t", inside.id, "ann", { doc_folder_id: f.folder.id });

    expect((await listDocuments("t", { folder: "root" })).map((d) => d.id)).toEqual([top.id]);
    expect((await listDocuments("t", { folder: f.folder.id })).map((d) => d.id)).toEqual([inside.id]);
    expect((await listDocuments("t")).map((d) => d.id).sort()).toEqual([top.id, inside.id].sort());
    expect((await listDocuments("t", { folder: f.folder.id }))[0].doc_folder_id).toBe(f.folder.id);
    expect(await listDocuments("t", { folder: "nope" })).toEqual([]);
  });

  it("moving to a folder isn't an edit: a later save with the old base doesn't conflict", async () => {
    const f = await createDocFolder("t", "ann", "Grants");
    if (!f.ok) throw new Error("folder");
    const d = await createDocument("t", "ann", { content_json: body("v1") });
    const moved = await updateDocument("t", d.id, "bob", { doc_folder_id: f.folder.id });
    expect(moved).toMatchObject({ ok: true, doc: { doc_folder_id: f.folder.id, updated_at: d.updated_at, updated_by: "ann" } });
    const saved = await updateDocument("t", d.id, "ann", { content_json: body("v2") }, d.updated_at);
    expect(saved).toMatchObject({ ok: true, doc: { doc_folder_id: f.folder.id, content_text: "v2" } });

    const out = await updateDocument("t", d.id, "bob", { doc_folder_id: null, archived: true });
    expect(out.ok && out.doc.updated_by).toBe("ann");
    // A move alongside a real edit still counts as an edit.
    const both = await updateDocument("t", d.id, "bob", { doc_folder_id: f.folder.id, title: "T" });
    expect(both.ok && both.doc.updated_by).toBe("bob");
  });

  it("bulk archives, restores, moves and deletes without bumping updated_at; foreign ids are missing", async () => {
    const f = await createDocFolder("t", "ann", "Grants");
    if (!f.ok) throw new Error("folder");
    const a = await createDocument("t", "ann");
    const b = await createDocument("t", "ann");
    const other = await createDocument("u", "zed");
    const ghost = "00000000-0000-4000-8000-000000000000";

    const archived = await bulkDocuments("t", "bob", { action: "archive", ids: [a.id, b.id, other.id, ghost] });
    expect(archived).toEqual({ done: [a.id, b.id], missing: [other.id, ghost] });
    expect(await getDocument("t", a.id)).toMatchObject({ archived: true, updated_at: a.updated_at, updated_by: "ann" });
    expect(await getDocument("u", other.id)).toMatchObject({ archived: false });

    expect(await bulkDocuments("t", "bob", { action: "restore", ids: [a.id] })).toEqual({ done: [a.id], missing: [] });
    expect(await getDocument("t", a.id)).toMatchObject({ archived: false, updated_at: a.updated_at });

    const moved = await bulkDocuments("t", "bob", { action: "move", ids: [a.id, b.id, other.id], doc_folder_id: f.folder.id });
    expect(moved).toEqual({ done: [a.id, b.id], missing: [other.id] });
    expect(await getDocument("t", b.id)).toMatchObject({ doc_folder_id: f.folder.id, updated_at: b.updated_at });
    expect((await getDocument("u", other.id))?.doc_folder_id).toBeNull();
    expect((await listDocuments("t", { folder: f.folder.id, archived: true })).map((d) => d.id)).toEqual([b.id]);

    await bulkDocuments("t", "bob", { action: "move", ids: [a.id], doc_folder_id: null });
    expect((await getDocument("t", a.id))?.doc_folder_id).toBeNull();

    expect(await bulkDocuments("t", "bob", { action: "delete", ids: [a.id, other.id] })).toEqual({ done: [a.id], missing: [other.id] });
    expect(await getDocument("t", a.id)).toBeNull();
    expect(await getDocument("u", other.id)).not.toBeNull();
  });
});
