import { beforeEach, describe, expect, it } from "vitest";
import { getSectionMeta, listSectionMeta, markSectionGenerated, putSectionNotes, resetSectionStore } from "./section-store";
import { createDocument, resetMemoryStore } from "./store";

describe("section store (in memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("reads a blank row for a section with none", async () => {
    const d = await createDocument("t", "ann");
    expect(await getSectionMeta("t", d.id, "s_abc12345")).toMatchObject({ section_id: "s_abc12345", notes: "", status: "empty", last_generated_at: null });
    expect(await listSectionMeta("t", d.id)).toEqual([]);
  });

  it("upserts notes, keeps the status, and marks a draft", async () => {
    const d = await createDocument("t", "ann");
    const first = await putSectionNotes("t", d.id, "s_1", { notes: "budget: $2M", specKey: "budget" });
    expect(first).toMatchObject({ notes: "budget: $2M", spec_key: "budget", status: "empty" });

    const drafted = await markSectionGenerated("t", d.id, "s_1", null);
    expect(drafted).toMatchObject({ status: "drafted", notes: "budget: $2M", spec_key: "budget" });
    expect(drafted?.last_generated_at).toBeTruthy();

    // A later notes save keeps the drafted status and (with no specKey given) the spec key.
    const again = await putSectionNotes("t", d.id, "s_1", { notes: "budget: $3M" });
    expect(again).toMatchObject({ notes: "budget: $3M", status: "drafted", spec_key: "budget" });
    expect(again!.updated_at > first!.updated_at).toBe(true);

    // null clears the spec key.
    expect(await putSectionNotes("t", d.id, "s_1", { notes: "x", specKey: null })).toMatchObject({ spec_key: null });

    await markSectionGenerated("t", d.id, "s_2", "intro");
    expect((await listSectionMeta("t", d.id))?.map((s) => [s.section_id, s.status])).toEqual([
      ["s_1", "drafted"],
      ["s_2", "drafted"],
    ]);
  });

  it("treats another team's document, bad ids and missing documents as not found", async () => {
    const d = await createDocument("org:a", "ann");
    await putSectionNotes("org:a", d.id, "s_1", { notes: "private" });
    expect(await listSectionMeta("org:b", d.id)).toBeNull();
    expect(await getSectionMeta("org:b", d.id, "s_1")).toBeNull();
    expect(await putSectionNotes("org:b", d.id, "s_1", { notes: "overwrite" })).toBeNull();
    expect(await markSectionGenerated("org:b", d.id, "s_1", null)).toBeNull();
    expect(await getSectionMeta("org:a", d.id, "s_1")).toMatchObject({ notes: "private" });

    expect(await listSectionMeta("org:a", "not-a-uuid")).toBeNull();
    expect(await getSectionMeta("org:a", d.id, "bad id!")).toBeNull();
    expect(await listSectionMeta("org:a", "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("is cleared by resetMemoryStore and resetSectionStore", async () => {
    const d = await createDocument("t", "ann");
    await putSectionNotes("t", d.id, "s_1", { notes: "n" });
    resetSectionStore();
    expect(await listSectionMeta("t", d.id)).toEqual([]);
    await putSectionNotes("t", d.id, "s_1", { notes: "n" });
    resetMemoryStore();
    const d2 = await createDocument("t", "ann");
    expect(await listSectionMeta("t", d2.id)).toEqual([]);
  });
});
