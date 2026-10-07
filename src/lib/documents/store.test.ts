import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, deleteDocument, getDocument, listDocuments, listVersions, resetMemoryStore, snapshotVersion, updateDocument } from "./store";

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
});
