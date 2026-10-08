import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeJson: vi.fn(), configured: { value: true } }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeJson: mocks.claudeJson,
  claudeConfigured: () => mocks.configured.value,
}));
vi.mock("@/catalog", async () => {
  const { fileTypes } = await import("@/catalog/files");
  return { listTypes: async () => fileTypes().map((definition) => ({ definition, origin: "file", enabled: true, overridden: false, updated_at: null })) };
});

import { createDocument, getDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { docOf, para } from "@/lib/sections/test-fixtures";
import { classifyDocument, ClassifyModelOutput, normalizeResult, resetClassifierMemory } from "./classify";
import { CLASSIFY_MIN_INTERVAL_MS } from "./contract";
import { dismissType } from "./store";

const T = "org:a";
// Hand-written edge cases (an unknown key, a duplicate); the real reply shape is pinned by recorded.test.ts.
const fixture = ClassifyModelOutput.parse(JSON.parse(readFileSync(new URL("./__fixtures__/classify.type.edge-cases.json", import.meta.url), "utf8")));
const reply = () => ({ data: fixture, usage: { model: "m", input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

const words = (n: number, w = "river") => Array.from({ length: n }, (_, i) => `${w}${i % 7 === 0 ? "" : " bank"}`).join(" ");
const proseDoc = (text = words(80)) => docOf(para("We request funding from the council to restore the river bank."), para(text));

describe("normalizeResult", () => {
  it("drops unknown keys, dedupes by key keeping the max, clamps, sorts and keeps 3", () => {
    const keys = new Set(["a", "b", "c", "d"]);
    const r = normalizeResult(
      {
        candidates: [
          { key: "b", confidence: 0.4, why: "b1" },
          { key: "zzz", confidence: 0.99, why: "unknown" },
          { key: "a", confidence: 1.4, why: "a" },
          { key: "b", confidence: 0.6, why: "b2" },
          { key: "c", confidence: -0.2, why: "c" },
          { key: "d", confidence: 0.1, why: "x".repeat(400) },
        ],
        freeform: false,
      },
      keys,
    );
    expect(r.candidates.map((c) => [c.key, c.confidence, c.why])).toEqual([
      ["a", 1, "a"],
      ["b", 0.6, "b2"],
      ["d", 0.1, "x".repeat(300)],
    ]);
    expect(r.freeform).toBe(false);
    expect(normalizeResult({ candidates: [{ key: "zzz", confidence: 0.9, why: "" }], freeform: false }, keys)).toEqual({ candidates: [], freeform: true });
  });

  it("normalizes the edge-case fixture against the catalog", () => {
    const r = normalizeResult(fixture, new Set(["proposal", "business-plan"]));
    expect(r).toEqual({
      candidates: [
        { key: "proposal", confidence: 0.86, why: fixture.candidates[0].why },
        { key: "business-plan", confidence: 0.31, why: fixture.candidates[1].why },
      ],
      freeform: false,
    });
  });
});

describe("classifyDocument", () => {
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  const now = () => clock;

  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetClassifierMemory();
    clock = Date.parse("2026-10-08T12:00:00.000Z");
    mocks.claudeJson.mockReset().mockResolvedValue(reply());
    mocks.configured.value = true;
  });

  it("runs the model, normalizes against enabled keys and persists without touching updated_at", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    const out = (await classifyDocument(T, d.id, { trigger: "content", agent: "ann", now }))!;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ran: true });
    const view = out.body.view;
    expect(view.type_confidence).toBe(0.86);
    expect(view.last_classified_at).toBe(new Date(clock).toISOString());
    expect(view.state.last).toMatchObject({ freeform: false, trigger: "content", at: new Date(clock).toISOString() });
    expect(view.state.last!.candidates.map((c) => c.key)).toEqual(["proposal", "business-plan"]);
    expect(view.state.words_at_last_run).toBeGreaterThan(40);

    const call = mocks.claudeJson.mock.calls[0][0];
    expect(call).toMatchObject({ task: "classify.type", agent: "ann", documentId: d.id, schema: ClassifyModelOutput });
    expect(call.system).toContain('<type key="proposal"');
    expect(call.system).not.toContain("river bank");
    expect(call.user).toContain("<document");

    const stored = (await getDocument(T, d.id))!;
    expect(stored.updated_at).toBe(d.updated_at);
    expect(stored.updated_by).toBe(d.updated_by);
    // An editor save with the base it already had still succeeds.
    const saved = await updateDocument(T, d.id, "ann", { title: "Mine" }, d.updated_at);
    expect(saved.ok).toBe(true);
  });

  it("skips without Claude, with too little text, and on a type the person chose", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    mocks.configured.value = false;
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.body).toMatchObject({ ran: false, reason: "not_configured" });
    mocks.configured.value = true;

    const short = await createDocument(T, "ann", { content_json: docOf(para("Only a few words here.")) });
    expect((await classifyDocument(T, short.id, { trigger: "content", now }))!.body).toMatchObject({ ran: false, reason: "too_short" });

    await updateDocument(T, d.id, "ann", { type_key: "general-report" });
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.body).toMatchObject({ ran: false, reason: "typed" });
    expect((await classifyDocument(T, d.id, { trigger: "notes", now }))!.body).toMatchObject({ ran: false, reason: "typed" });
    expect((await classifyDocument(T, d.id, { trigger: "drift", now }))!.body).toMatchObject({ ran: true });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("counts notes towards the minimum", async () => {
    const d = await createDocument(T, "ann", { content_json: docOf(para("Short body.")) });
    await updateDocument(T, d.id, "ann", { notes: words(60) });
    expect((await classifyDocument(T, d.id, { trigger: "notes", now }))!.body).toMatchObject({ ran: true });
  });

  it("answers 429 inside the window with retryAfterMs, and runs again after it", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    await classifyDocument(T, d.id, { trigger: "content", now });
    clock += 30_000;
    const limited = (await classifyDocument(T, d.id, { trigger: "content", now }))!;
    expect(limited.status).toBe(429);
    if (limited.status !== 429) throw new Error("expected 429");
    expect(limited.body.retryAfterMs).toBe(CLASSIFY_MIN_INTERVAL_MS - 30_000);
    expect(limited.body.view.state.last).not.toBeNull();
    // force bypasses the gate (but an unchanged input still short-circuits).
    expect((await classifyDocument(T, d.id, { trigger: "manual", force: true, now }))!.body).toMatchObject({ ran: false, reason: "unchanged" });
    clock += CLASSIFY_MIN_INTERVAL_MS;
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.body).toMatchObject({ ran: false, reason: "unchanged" });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("short-circuits an unchanged input and reruns when the text changes", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    await classifyDocument(T, d.id, { trigger: "content", now });
    clock += CLASSIFY_MIN_INTERVAL_MS;
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.body).toMatchObject({ ran: false, reason: "unchanged" });
    await updateDocument(T, d.id, "ann", { content_json: proseDoc(words(90, "budget")) });
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.body).toMatchObject({ ran: true });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(2);
  });

  it("shares a run in flight between concurrent calls", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    let release!: () => void;
    mocks.claudeJson.mockImplementation(() => new Promise((resolve) => (release = () => resolve(reply()))));
    const a = classifyDocument(T, d.id, { trigger: "content", now });
    const b = classifyDocument(T, d.id, { trigger: "content", now });
    await vi.waitFor(() => expect(mocks.claudeJson).toHaveBeenCalledTimes(1));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra!.body).toMatchObject({ ran: true });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("records last_classified_at when the model fails, so it isn't asked again at once", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.claudeJson.mockRejectedValueOnce(new Error("overloaded"));
    const out = (await classifyDocument(T, d.id, { trigger: "content", now }))!;
    expect(out.body).toMatchObject({ ran: false, reason: "failed" });
    expect(out.body.view.last_classified_at).toBe(new Date(clock).toISOString());
    expect(out.body.view.state.last).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    const stored = (await getDocument(T, d.id))!;
    expect(stored.updated_at).toBe(d.updated_at);
    clock += 1000;
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.status).toBe(429);
    // A failed run left no hash behind: after the window it asks again.
    clock += CLASSIFY_MIN_INTERVAL_MS;
    expect((await classifyDocument(T, d.id, { trigger: "content", now }))!.body).toMatchObject({ ran: true });
  });

  it("keeps dismissals made while a run was in flight", async () => {
    const d = await createDocument(T, "ann", { content_json: proseDoc() });
    let release!: () => void;
    mocks.claudeJson.mockImplementation(() => new Promise((resolve) => (release = () => resolve(reply()))));
    const running = classifyDocument(T, d.id, { trigger: "content", now });
    await vi.waitFor(() => expect(mocks.claudeJson).toHaveBeenCalledTimes(1));
    await dismissType(T, d.id, "business-plan");
    release();
    const out = (await running)!;
    expect(out.body.view.state.dismissals).toEqual({ "business-plan": 1 });
    expect(out.body.view.state.last).not.toBeNull();
  });

  it("returns null for another team's document", async () => {
    const d = await createDocument("org:b", "bob", { content_json: proseDoc() });
    expect(await classifyDocument(T, d.id, { trigger: "content", now })).toBeNull();
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });
});
