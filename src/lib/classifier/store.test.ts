import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, getDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { ClassifierState } from "./contract";
import { classifierView, dismissType, writeClassifierFields } from "./store";
import { startsFresh } from "./trigger";

const T = "org:a";

describe("classifier store (memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("records a result without bumping updated_at", async () => {
    const d = await createDocument(T, "ann");
    const state = ClassifierState.parse({
      last: { candidates: [{ key: "proposal", confidence: 0.9, why: "asks for money" }], freeform: false, at: "2026-10-08T00:00:00.000Z", trigger: "content" },
      words_at_last_run: 120,
    });
    const saved = (await writeClassifierFields(T, d.id, { type_confidence: 0.9, last_classified_at: "2026-10-08T00:00:00Z", classifier_state: state }))!;
    expect(classifierView(saved)).toEqual({
      type_key: null,
      type_source: null,
      type_confidence: 0.9,
      last_classified_at: "2026-10-08T00:00:00.000Z",
      state,
    });
    const stored = (await getDocument(T, d.id))!;
    expect(stored.updated_at).toBe(d.updated_at);
    expect(stored.classifier_state).toEqual(state);
    expect((await updateDocument(T, d.id, "ann", { title: "x" }, d.updated_at)).ok).toBe(true);
  });

  it("writes only the fields given and keeps the rest of the record current", async () => {
    const d = await createDocument(T, "ann");
    await writeClassifierFields(T, d.id, { type_confidence: 0.5 });
    await updateDocument(T, d.id, "ann", { title: "New title" });
    const after = (await writeClassifierFields(T, d.id, { last_classified_at: "2026-10-08T01:00:00Z" }))!;
    expect(after.title).toBe("New title");
    expect(after.type_confidence).toBe(0.5);
    expect(after.last_classified_at).toBe("2026-10-08T01:00:00.000Z");
  });

  it("dismisses: counts the type and clears the last result", async () => {
    const d = await createDocument(T, "ann");
    await writeClassifierFields(T, d.id, {
      classifier_state: ClassifierState.parse({ last: { candidates: [], freeform: true, at: "2026-10-08T00:00:00.000Z", trigger: "notes" } }),
    });
    await dismissType(T, d.id, "proposal");
    const twice = (await dismissType(T, d.id, "proposal"))!;
    expect(twice.classifier_state).toMatchObject({ last: null, dismissals: { proposal: 2 } });
    expect(twice.updated_at).toBe(d.updated_at);
  });

  it("a dismissed document keeps words_at_last_run, so the next session doesn't treat it as never classified", async () => {
    const d = await createDocument(T, "ann");
    await writeClassifierFields(T, d.id, {
      last_classified_at: "2026-10-08T00:00:00Z",
      classifier_state: ClassifierState.parse({
        last: { candidates: [{ key: "business_plan", confidence: 0.9, why: "a plan" }], freeform: false, at: "2026-10-08T00:00:00.000Z", trigger: "content" },
        words_at_last_run: 300,
      }),
    });
    const dismissed = (await dismissType(T, d.id, "business_plan"))!;
    expect(dismissed.classifier_state).toMatchObject({ last: null, words_at_last_run: 300 });
    expect(startsFresh(classifierView(dismissed))).toBe(false);
    expect(startsFresh(classifierView(d))).toBe(true);
  });

  it("is a no-op for another team's document", async () => {
    const d = await createDocument("org:b", "bob");
    expect(await writeClassifierFields(T, d.id, { type_confidence: 1 })).toBeNull();
    expect(await dismissType(T, d.id, "proposal")).toBeNull();
    const theirs = (await getDocument("org:b", d.id))!;
    expect(theirs.type_confidence).toBeNull();
    expect(theirs.classifier_state.dismissals).toEqual({});
  });
});
