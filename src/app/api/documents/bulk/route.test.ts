import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocFolder } from "@/lib/documents/folder-store";
import { createDocument, getDocument, resetMemoryStore } from "@/lib/documents/store";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://x/api/documents/bulk", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/documents/bulk", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("archives and reports ids outside the team as missing", async () => {
    const a = await createDocument("org:a", "ann");
    const other = await createDocument("org:b", "zed");
    const res = await post({ action: "archive", ids: [a.id, other.id] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: "archive", done: [a.id], missing: [other.id] });
    expect(await getDocument("org:a", a.id)).toMatchObject({ archived: true, updated_at: a.updated_at });
    expect(await getDocument("org:b", other.id)).toMatchObject({ archived: false });
  });

  it("moves to a folder of the team or the top level, and 400s an unknown folder", async () => {
    const a = await createDocument("org:a", "ann");
    const mine = await createDocFolder("org:a", "ann", "Grants");
    const theirs = await createDocFolder("org:b", "zed", "Theirs");
    if (!mine.ok || !theirs.ok) throw new Error("folder");

    const moved = await post({ action: "move", ids: [a.id], doc_folder_id: mine.folder.id });
    expect(await moved.json()).toEqual({ action: "move", done: [a.id], missing: [] });
    expect((await getDocument("org:a", a.id))?.doc_folder_id).toBe(mine.folder.id);

    const foreign = await post({ action: "move", ids: [a.id], doc_folder_id: theirs.folder.id });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ error: "Unknown folder." });
    expect((await getDocument("org:a", a.id))?.doc_folder_id).toBe(mine.folder.id);

    await post({ action: "move", ids: [a.id], doc_folder_id: null });
    expect((await getDocument("org:a", a.id))?.doc_folder_id).toBeNull();
  });

  it("deletes", async () => {
    const a = await createDocument("org:a", "ann");
    expect(await (await post({ action: "delete", ids: [a.id] })).json()).toEqual({ action: "delete", done: [a.id], missing: [] });
    expect(await getDocument("org:a", a.id)).toBeNull();
  });

  it("400s an invalid body", async () => {
    expect((await post({ action: "archive", ids: [] })).status).toBe(400);
    expect((await post({ action: "archive", ids: ["nope"] })).status).toBe(400);
    expect((await post({ action: "move", ids: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    const res = await post({ action: "explode", ids: ["00000000-0000-4000-8000-000000000000"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request." });
  });
});
