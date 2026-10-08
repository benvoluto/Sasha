import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, getDocument, listDocuments, resetMemoryStore, updateDocument } from "./store";

const T = "org:a";

describe("document store: Phase 4 fields", () => {
  beforeEach(() => resetMemoryStore());

  it("starts with an empty classifier state and records who set the type", async () => {
    const untyped = await createDocument(T, "u1");
    expect(untyped.type_source).toBeNull();
    expect(untyped.classifier_state).toEqual({ last: null, dismissals: {}, words_at_last_run: 0 });
    const typed = await createDocument(T, "u1", { type_key: "proposal" });
    expect(typed.type_source).toBe("user");
  });

  it("takes type_source with type_key, defaults it to user, and clears it with the type", async () => {
    const d = await createDocument(T, "u1");
    const a = await updateDocument(T, d.id, "u1", { type_key: "prd", type_source: "classifier" }, d.updated_at);
    expect(a.ok && a.doc.type_source).toBe("classifier");
    const b = await updateDocument(T, d.id, "u1", { type_key: "sop" });
    expect(b.ok && b.doc.type_source).toBe("user");
    const c = await updateDocument(T, d.id, "u1", { type_key: null });
    expect(c.ok && c.doc.type_source).toBeNull();
  });

  it("ignores type_source without type_key, and counts a notes save as an edit", async () => {
    const d = await createDocument(T, "u1", { type_key: "prd" });
    const r = await updateDocument(T, d.id, "u1", { notes: "hello", type_source: "classifier" }, d.updated_at);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.type_source).toBe("user");
    expect(r.doc.notes).toBe("hello");
    expect(r.doc.updated_at > d.updated_at).toBe(true);
    // A save based on the version before the notes save conflicts.
    const stale = await updateDocument(T, d.id, "u1", { title: "x" }, d.updated_at);
    expect(stale.ok).toBe(false);
  });

  it("keeps notes and the classifier state out of list summaries", async () => {
    const d = await createDocument(T, "u1");
    await updateDocument(T, d.id, "u1", { notes: "secret plan" });
    const [s] = await listDocuments(T);
    expect(s).not.toHaveProperty("notes");
    expect(s).not.toHaveProperty("classifier_state");
    expect((await getDocument(T, d.id))?.notes).toBe("secret plan");
  });
});
