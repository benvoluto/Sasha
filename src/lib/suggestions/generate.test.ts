import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeJson: vi.fn(), getType: vi.fn(), listDocumentSources: vi.fn(), configured: { value: true } }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeJson: mocks.claudeJson,
  claudeConfigured: () => mocks.configured.value,
}));
vi.mock("@/catalog", () => ({ getType: mocks.getType }));
vi.mock("@/lib/sources/store", () => ({ listDocumentSources: mocks.listDocumentSources }));

import { fileTypeByKey } from "@/catalog/files";
import { createDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
// Hand-written edge cases (an unknown item, an unlinked id, a duplicate); the real reply shape is pinned by recorded.test.ts.
import fixture from "./__fixtures__/suggest.items.edge-cases.json";
import { generateSuggestions, getSuggestionList, judgeReply, MIN_GENERATE_INTERVAL_MS, resetSuggestionGenerator } from "./generate";
import { SuggestModelOutput } from "./prompt";
import { listSuggestions, setSuggestionState } from "./store";
import { typeNeeds } from "./diff";

const T = "org:a";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const def = fileTypeByKey("proposal")!;
const entry = { definition: def, origin: "file", enabled: true, overridden: false, updated_at: null };
const linked = (id: string, title: string, summary: string | null) => ({ id, kind: "note", title, filename: null, url: null, summary, role: null, added_at: "2026-01-01T00:00:00.000Z" });
const SOURCES = [linked(S1, "Budget note", "Total cost £40k; quotes from two contractors."), linked(S2, "Cost sheet", "Some cost lines.")];
const NOTES = "The foundation asks for audited accounts with every application, and the county council has backed the river bank restoration work for years.";

describe("generateSuggestions", () => {
  let clock = 10_000_000;
  const now = () => clock;

  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSuggestionGenerator();
    clock = 10_000_000;
    mocks.configured.value = true;
    mocks.getType.mockReset().mockImplementation(async (_t: string, key: string | null) => (key ? entry : null));
    mocks.listDocumentSources.mockReset().mockResolvedValue(SOURCES);
    mocks.claudeJson.mockReset().mockResolvedValue({ data: SuggestModelOutput.parse(fixture), usage: {} });
  });

  const typedDoc = async (notes = NOTES) => {
    const d = await createDocument(T, "ann", { type_key: "proposal" });
    if (notes) await updateDocument(T, d.id, "ann", { notes });
    return d;
  };

  it("does nothing for an untyped document without notes", async () => {
    mocks.listDocumentSources.mockResolvedValue([]);
    const d = await createDocument(T, "ann");
    const r = (await generateSuggestions(T, d.id, { now }))!;
    expect(r.suggestions).toEqual([]);
    expect(r.stale).toBe(false);
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });

  it("writes the type items uncovered without Claude", async () => {
    mocks.configured.value = false;
    const d = await typedDoc();
    const r = (await generateSuggestions(T, d.id, { now }))!;
    expect(r.ran).toBe(false);
    expect(r.suggestions.map((s) => [s.label, s.state, s.origin])).toEqual(typeNeeds(def).map((i) => [i.label, "open", "type"]));
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });

  it("applies the edge-case reply: coverage marks added with the source, partial annotates, bad ids and refs dropped", async () => {
    const d = await typedDoc();
    const r = (await generateSuggestions(T, d.id, { now, agent: "ann" }))!;
    expect(r.ran).toBe(true);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    const call = mocks.claudeJson.mock.calls[0][0];
    expect(call).toMatchObject({ task: "suggest.items", agent: "ann", documentId: d.id });
    expect(call.user).toContain("1. [data] Total cost (section: Summary)");
    expect(call.user).toContain(`<source id="${S1}" title="Budget note">`);
    const by = (label: string) => r.suggestions.find((s) => s.label === label);
    expect(by("Total cost")).toMatchObject({ state: "added", source_id: S1 });
    expect(by("Quotes or cost estimates")).toMatchObject({ state: "added", source_id: S1 });
    // An id that isn't linked is ignored.
    expect(by("Baseline figures")).toMatchObject({ state: "open", source_id: null });
    expect(by("Cost figures")).toMatchObject({ state: "open", origin: "type", spec_ref: "budget" });
    expect(by("Cost figures")!.reason).toContain("(partly covered by Cost sheet)");
    expect(by("Last year's audited financials")).toMatchObject({ origin: "notes", kind: "data", spec_ref: "budget", state: "open" });
    // spec_ref outside the type's sections → null.
    expect(by("Letter of support from the county council")).toMatchObject({ origin: "notes", spec_ref: null });
    // The duplicate of a type item ("Cost figures.") was not written twice.
    expect(r.suggestions.filter((s) => s.label.toLowerCase().startsWith("cost figures"))).toHaveLength(1);
    expect(r.stale).toBe(false);
    expect(r.error).toBeNull();
  });

  it("whitelists coverage indices and source ids (pure)", () => {
    const items = typeNeeds(def);
    const out = judgeReply(
      { coverage: [{ item: 0, status: "covered", source_id: S1 }, { item: 2, status: "covered", source_id: " " + S1 + " " }], proposals: [{ kind: "source", label: "  ", reason: "", spec_ref: null }] },
      items,
      [{ id: S1, title: "A" }],
      new Set(["budget"]),
    );
    expect(out.typeItems[0].covered_by).toBeUndefined();
    expect(out.typeItems[1].covered_by).toBe(S1);
    expect(out.proposals).toEqual([]);
  });

  it("skips unchanged inputs and gates runs to once a minute", async () => {
    const d = await typedDoc();
    await generateSuggestions(T, d.id, { now });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    // Unchanged → no call, even after the gate opens.
    clock += MIN_GENERATE_INTERVAL_MS * 2;
    const same = (await generateSuggestions(T, d.id, { now }))!;
    expect(same.ran).toBe(false);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    // Forced, but inside the gate → held back with the time left.
    const doc = (await listSuggestions(T, d.id))!;
    expect(doc.length).toBeGreaterThan(0);
    const forced = (await generateSuggestions(T, d.id, { now, force: true }))!;
    expect(forced.ran).toBe(true);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(2);
    clock += 1_000;
    const gated = (await generateSuggestions(T, d.id, { now, force: true }))!;
    expect(gated).toMatchObject({ ran: false });
    expect(gated.retry_after_ms).toBe(MIN_GENERATE_INTERVAL_MS - 1_000);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(2);
  });

  it("reports stale once the inputs change", async () => {
    const d = await typedDoc();
    expect((await getSuggestionList(T, d.id))!.stale).toBe(true);
    await generateSuggestions(T, d.id, { now });
    expect((await getSuggestionList(T, d.id))!.stale).toBe(false);
    mocks.listDocumentSources.mockResolvedValue([SOURCES[0]]);
    expect((await getSuggestionList(T, d.id))!.stale).toBe(true);
  });

  it("shares one run between concurrent requests", async () => {
    const d = await typedDoc();
    let release!: () => void;
    mocks.claudeJson.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ data: SuggestModelOutput.parse(fixture), usage: {} }))));
    const a = generateSuggestions(T, d.id, { now });
    const b = generateSuggestions(T, d.id, { now });
    await vi.waitFor(() => expect(mocks.claudeJson).toHaveBeenCalledTimes(1));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("records a failure and keeps the old list", async () => {
    const d = await typedDoc();
    await generateSuggestions(T, d.id, { now });
    const before = (await listSuggestions(T, d.id))!;
    mocks.claudeJson.mockRejectedValue(new Error("overloaded"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    clock += MIN_GENERATE_INTERVAL_MS;
    const r = (await generateSuggestions(T, d.id, { now, force: true }))!;
    expect(r).toMatchObject({ ran: false, error: "overloaded" });
    expect(r.suggestions).toEqual(before);
    expect(err).toHaveBeenCalled();
    // Still stale, so opening the tab retries instead of showing the failed run as current.
    expect(r.stale).toBe(true);
    expect((await getSuggestionList(T, d.id))!.stale).toBe(true);
    err.mockRestore();
  });

  it("a failed first run still lists the type items, stays stale, and a later run judges them", async () => {
    const d = await typedDoc();
    mocks.claudeJson.mockRejectedValueOnce(new Error("overloaded"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = (await generateSuggestions(T, d.id, { now }))!;
    expect(r).toMatchObject({ ran: false, error: "overloaded", stale: true });
    expect(r.suggestions.map((s) => [s.label, s.state, s.origin])).toEqual(typeNeeds(def).map((i) => [i.label, "open", "type"]));
    const list = (await getSuggestionList(T, d.id))!;
    expect(list).toMatchObject({ stale: true, error: "overloaded" });
    // The pane's retry (no force) runs once the gate opens.
    clock += MIN_GENERATE_INTERVAL_MS;
    const again = (await generateSuggestions(T, d.id, { now }))!;
    expect(again).toMatchObject({ ran: true, stale: false, error: null });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(2);
    expect(again.suggestions.find((s) => s.label === "Total cost")).toMatchObject({ state: "added", source_id: S1 });
    err.mockRestore();
  });

  it("keeps dismissed items dismissed and out of the prompt", async () => {
    const d = await typedDoc();
    mocks.configured.value = false;
    const first = (await generateSuggestions(T, d.id, { now }))!;
    const total = first.suggestions.find((s) => s.label === "Total cost")!;
    await setSuggestionState(T, d.id, total.id, "dismiss");
    mocks.configured.value = true;
    mocks.claudeJson.mockResolvedValue({ data: { coverage: [], proposals: [] }, usage: {} });
    clock += MIN_GENERATE_INTERVAL_MS;
    const r = (await generateSuggestions(T, d.id, { now, force: true }))!;
    expect(mocks.claudeJson.mock.calls[0][0].user).not.toContain("[data] Total cost");
    expect(r.suggestions.find((s) => s.label === "Total cost")).toMatchObject({ state: "dismissed" });
  });

  it("returns null for another team's document", async () => {
    const d = await typedDoc();
    expect(await generateSuggestions("org:b", d.id, { now })).toBeNull();
    expect(await getSuggestionList("org:b", d.id)).toBeNull();
  });
});
