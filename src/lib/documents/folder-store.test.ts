import { beforeEach, describe, expect, it } from "vitest";
import { createDocFolder, deleteDocFolder, getDocFolder, listDocFolders, renameDocFolder } from "./folder-store";
import { createDocument, getDocument, resetMemoryStore, updateDocument } from "./store";

async function folder(team: string, name: string) {
  const r = await createDocFolder(team, "ann", name);
  if (!r.ok) throw new Error("duplicate");
  return r.folder;
}

describe("document folder store (in memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("lists folders by name ignoring case, counting only non-archived documents", async () => {
    const b = await folder("t", "budgets");
    const a = await folder("t", "Applications");
    await folder("t", "  Contracts  ");
    expect(a).toMatchObject({ name: "Applications", document_count: 0, created_by: "ann" });

    const d1 = await createDocument("t", "ann");
    const d2 = await createDocument("t", "ann");
    await updateDocument("t", d1.id, "ann", { doc_folder_id: b.id });
    await updateDocument("t", d2.id, "ann", { doc_folder_id: b.id, archived: true });

    const list = await listDocFolders("t");
    expect(list.map((f) => f.name)).toEqual(["Applications", "budgets", "Contracts"]);
    expect(list.find((f) => f.id === b.id)?.document_count).toBe(1);
    expect((await getDocFolder("t", b.id))?.document_count).toBe(1);
  });

  it("refuses a duplicate name ignoring case, on create and rename", async () => {
    const a = await folder("t", "Grants");
    expect(await createDocFolder("t", "bob", "grants")).toEqual({ ok: false, reason: "duplicate" });
    const b = await folder("t", "Other");
    expect(await renameDocFolder("t", b.id, "GRANTS")).toEqual({ ok: false, reason: "duplicate" });
    // Renaming a folder to its own name in another case is fine.
    expect(await renameDocFolder("t", a.id, "GRANTS")).toMatchObject({ ok: true, folder: { name: "GRANTS" } });
    // Another team may use the same name.
    expect((await createDocFolder("u", "ann", "Grants")).ok).toBe(true);
  });

  it("renaming bumps updated_at", async () => {
    const a = await folder("t", "Old");
    const r = await renameDocFolder("t", a.id, "New");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.folder.name).toBe("New");
    expect(r.folder.updated_at > a.updated_at).toBe(true);
    expect(r.folder.created_at).toBe(a.created_at);
  });

  it("moving documents in or out bumps the folder's updated_at", async () => {
    const a = await folder("t", "A");
    const b = await folder("t", "B");
    const d = await createDocument("t", "ann");
    await updateDocument("t", d.id, "ann", { doc_folder_id: a.id });
    const a1 = (await getDocFolder("t", a.id))!.updated_at;
    expect(a1 > a.updated_at).toBe(true);
    await updateDocument("t", d.id, "ann", { doc_folder_id: b.id });
    expect((await getDocFolder("t", a.id))!.updated_at > a1).toBe(true);
    expect((await getDocFolder("t", b.id))!.updated_at > b.updated_at).toBe(true);
  });

  it("deleting a folder moves its documents (archived too) to the top level", async () => {
    const a = await folder("t", "A");
    const keep = await folder("t", "Keep");
    const d1 = await createDocument("t", "ann");
    const d2 = await createDocument("t", "ann");
    const d3 = await createDocument("t", "ann");
    await updateDocument("t", d1.id, "ann", { doc_folder_id: a.id });
    await updateDocument("t", d2.id, "ann", { doc_folder_id: a.id, archived: true });
    await updateDocument("t", d3.id, "ann", { doc_folder_id: keep.id });

    expect(await deleteDocFolder("t", a.id)).toEqual({ moved: 2 });
    expect(await getDocFolder("t", a.id)).toBeNull();
    expect((await getDocument("t", d1.id))?.doc_folder_id).toBeNull();
    expect((await getDocument("t", d2.id))).toMatchObject({ doc_folder_id: null, archived: true });
    expect((await getDocument("t", d3.id))?.doc_folder_id).toBe(keep.id);
    expect(await deleteDocFolder("t", a.id)).toBeNull();
  });

  it("scopes folders to a team", async () => {
    const a = await folder("t", "Mine");
    expect(await listDocFolders("u")).toEqual([]);
    expect(await getDocFolder("u", a.id)).toBeNull();
    expect(await renameDocFolder("u", a.id, "Theirs")).toEqual({ ok: false, reason: "not_found" });
    expect(await deleteDocFolder("u", a.id)).toBeNull();
    expect((await getDocFolder("t", a.id))?.name).toBe("Mine");
    expect(await getDocFolder("t", "not-a-uuid")).toBeNull();
  });

  it("resetMemoryStore clears folders", async () => {
    await folder("t", "A");
    resetMemoryStore();
    expect(await listDocFolders("t")).toEqual([]);
  });
});
