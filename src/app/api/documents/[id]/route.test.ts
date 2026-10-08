import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocFolder, getDocFolder } from "@/lib/documents/folder-store";
import { createDocument, getDocument, resetMemoryStore } from "@/lib/documents/store";
import { PATCH } from "./route";

const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("PATCH /api/documents/[id] doc_folder_id", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("moves a document into a folder and back without bumping updated_at", async () => {
    const d = await createDocument("org:a", "ann");
    const f = await createDocFolder("org:a", "ann", "Grants");
    if (!f.ok) throw new Error("folder");
    const res = await patch(d.id, { doc_folder_id: f.folder.id });
    expect(res.status).toBe(200);
    expect((await res.json()).document).toMatchObject({ doc_folder_id: f.folder.id, updated_at: d.updated_at });
    expect((await getDocFolder("org:a", f.folder.id))?.document_count).toBe(1);

    // The editor's next save with its old base still goes through.
    const saved = await patch(d.id, { title: "Kept", base_updated_at: d.updated_at });
    expect(saved.status).toBe(200);

    expect((await (await patch(d.id, { doc_folder_id: null })).json()).document.doc_folder_id).toBeNull();
  });

  it("400s an unknown or another team's folder and leaves the document alone", async () => {
    const d = await createDocument("org:a", "ann");
    const theirs = await createDocFolder("org:b", "zed", "Theirs");
    if (!theirs.ok) throw new Error("folder");
    const res = await patch(d.id, { doc_folder_id: theirs.folder.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown folder." });
    const ghost = await patch(d.id, { doc_folder_id: "00000000-0000-4000-8000-000000000000" });
    expect(ghost.status).toBe(400);
    expect((await patch(d.id, { doc_folder_id: "nope" })).status).toBe(400);
    expect((await getDocument("org:a", d.id))?.doc_folder_id).toBeNull();
  });
});
