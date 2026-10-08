import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocFolder, getDocFolder } from "@/lib/documents/folder-store";
import { createDocument, getDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { DELETE, PATCH } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/document-folders/${id}`, { method: "PATCH", body: JSON.stringify(body) }), ctx(id));
const del = (id: string) => DELETE(new Request(`http://x/api/document-folders/${id}`, { method: "DELETE" }), ctx(id));

async function folder(team: string, name: string) {
  const r = await createDocFolder(team, "ann", name);
  if (!r.ok) throw new Error("duplicate");
  return r.folder;
}

describe("/api/document-folders/[id]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("renames a folder", async () => {
    const f = await folder("org:a", "Old");
    const res = await patch(f.id, { name: "New" });
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toMatchObject({ id: f.id, name: "New" });
  });

  it("400s a bad name, 409s a duplicate and 404s an unknown or foreign folder", async () => {
    const f = await folder("org:a", "One");
    await folder("org:a", "Two");
    const foreign = await folder("org:b", "Theirs");
    expect((await patch(f.id, { name: "" })).status).toBe(400);
    const dup = await patch(f.id, { name: "two" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "A folder with that name already exists." });
    const missing = await patch(foreign.id, { name: "Mine" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Folder not found." });
    expect((await patch("nope", { name: "X" })).status).toBe(404);
    expect((await getDocFolder("org:b", foreign.id))?.name).toBe("Theirs");
  });

  it("deletes a folder, moving its documents to the top level", async () => {
    const f = await folder("org:a", "Grants");
    const d1 = await createDocument("org:a", "ann");
    const d2 = await createDocument("org:a", "ann");
    await updateDocument("org:a", d1.id, "ann", { doc_folder_id: f.id });
    await updateDocument("org:a", d2.id, "ann", { doc_folder_id: f.id, archived: true });

    const res = await del(f.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, moved: 2 });
    expect((await getDocument("org:a", d2.id))?.doc_folder_id).toBeNull();

    const again = await del(f.id);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Folder not found." });
    const foreign = await folder("org:b", "Theirs");
    expect((await del(foreign.id)).status).toBe(404);
  });
});
