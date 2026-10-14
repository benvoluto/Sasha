import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import * as documents from "@/lib/documents/store";
import { listDocuments, resetMemoryStore } from "@/lib/documents/store";
import { createNote, getNote } from "@/lib/notes/store";
import { POST } from "./route";

const start = (id: string) => POST(new Request(`http://x/api/notes/${id}/start-document`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe("POST /api/notes/[id]/start-document", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    vi.restoreAllMocks();
  });

  it("turns the note into a document's notes and removes the note", async () => {
    const n = await createNote("org:a", "ann", "Grant ideas\nask for 50k");
    const res = await start(n.id);
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document.title).toBe("Grant ideas");
    expect(await getNote("org:a", n.id)).toBeNull();
    expect((await start(n.id)).status).toBe(404);
  });

  it("makes one document when two requests race for the same note", async () => {
    const n = await createNote("org:a", "ann", "Once");
    const statuses = (await Promise.all([start(n.id), start(n.id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 404]);
    expect((await listDocuments("org:a")).filter((d) => d.title === "Once")).toHaveLength(1);
  });

  it("keeps the note when the document can't be created", async () => {
    const n = await createNote("org:a", "ann", "Keep me");
    vi.spyOn(documents, "createDocument").mockRejectedValueOnce(new Error("db down"));
    await expect(start(n.id)).rejects.toThrow("db down");
    expect(await getNote("org:a", n.id)).toEqual(n);
  });
});
