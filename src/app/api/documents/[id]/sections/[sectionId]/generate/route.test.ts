import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeText: vi.fn(), getType: vi.fn() }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/catalog", () => ({ getType: mocks.getType }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeText: mocks.claudeText,
  claudeConfigured: () => true,
}));

import { CITE_SOURCES_INSTRUCTION } from "@/lib/citations/contract";
import { createDocument, deleteDocument, resetMemoryStore } from "@/lib/documents/store";
import { docOf, heading, para, testType } from "@/lib/sections/test-fixtures";
import { passagePrefix } from "@/lib/sources/pages";
import { createSource, linkSource, replacePassages, resetSourceStore } from "@/lib/sources/store";
import { POST } from "./route";

const def = testType();
const call = (id: string, sectionId: string, body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id, sectionId }) });

describe("POST /api/documents/[id]/sections/[sectionId]/generate citations", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    mocks.getType.mockReset().mockResolvedValue({ definition: def, origin: "file", enabled: true, overridden: false, updated_at: null });
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  async function setup() {
    const d = await createDocument("org:a", "ann", { type_key: def.key, content_json: docOf(heading("Budget", "s_bud", "budget"), para("")) });
    const s = await createSource("org:a", "ann", { kind: "note", title: "Cost study", extracted_text: "Staff cost $10k.", extraction_status: "ready" });
    const id = `${passagePrefix(s.id)}.P0`;
    await replacePassages("org:a", s.id, [{ id, idx: 0, page: null, start_offset: 0, end_offset: 16, text: "Staff cost $10k." }]);
    await linkSource("org:a", "ann", d.id, s.id);
    return { d, id };
  }

  it("returns the verified markdown with citations kept and dropped", async () => {
    const { d, id } = await setup();
    mocks.claudeText.mockResolvedValue({ text: `Staff cost $10k.[[p:${id}]] Rent too.[[p:Sffffffff.P1|rent]]`, usage: {} });
    const res = await call(d.id, "s_bud", { mode: "draft", heading: "Budget", specKey: "budget" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markdown).toBe(`Staff cost $10k.[[p:${id}]] Rent too.`);
    expect(body.citations.kept).toBe(1);
    expect(body.citations.dropped).toEqual([{ raw: "[[p:Sffffffff.P1|rent]]", passageId: "Sffffffff.P1", reason: "unknown_passage" }]);
    expect(Object.keys(body.citations.passages)).toEqual([id]);
  });

  it("answers 422 when Cite sources changed the wording", async () => {
    const { d, id } = await setup();
    mocks.claudeText.mockResolvedValue({ text: `Personnel expenses were about ten thousand.[[p:${id}]]`, usage: {} });
    const res = await call(d.id, "s_bud", { mode: "rewrite", heading: "Budget", body: "Staff cost $10k.", instruction: CITE_SOURCES_INSTRUCTION });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Claude changed the wording; nothing was applied." });
  });
});

describe("POST /api/documents/[id]/sections/[sectionId]/generate rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    process.env.SASHA_LIMIT_DRAFT_USER = "1/1h";
    resetMemoryStore();
    mocks.claudeText.mockReset().mockResolvedValue({ text: "Drafted.", usage: {} });
    mocks.getType.mockReset().mockResolvedValue({ definition: def, origin: "file", enabled: true, overridden: false, updated_at: null });
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_DRAFT_USER;
  });

  it("429s with Retry-After and a RateLimitedBody once the draft allowance is used, without calling the model", async () => {
    const d = await createDocument("org:a", "ann", { type_key: def.key, content_json: docOf(heading("Budget", "s_bud", "budget"), para("")) });
    // A request refused before the model ran gives its call back.
    expect((await call(crypto.randomUUID(), "s_bud", { mode: "draft", heading: "Budget" })).status).toBe(404);
    expect((await call(d.id, "s_bud", { mode: "draft", heading: "Budget", specKey: "budget" })).status).toBe(200);
    const res = await call(d.id, "s_bud", { mode: "draft", heading: "Budget", specKey: "budget" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(3500);
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/^You've used your 1 draft for this hour\. Try again in \d+ min\.$/),
      code: "rate_limited",
      scope: "user",
      family: "draft",
      retry_after_seconds: expect.any(Number),
    });
    expect(mocks.claudeText).toHaveBeenCalledTimes(1);
  });

  it("keeps the call charged when the document is deleted while the model runs", async () => {
    const d = await createDocument("org:a", "ann", { type_key: def.key, content_json: docOf(heading("Budget", "s_bud", "budget"), para("")) });
    mocks.claudeText.mockImplementationOnce(async () => {
      await deleteDocument("org:a", d.id);
      return { text: "Drafted.", usage: {} };
    });
    expect((await call(d.id, "s_bud", { mode: "draft", heading: "Budget", specKey: "budget" })).status).toBe(404);
    const d2 = await createDocument("org:a", "ann", { type_key: def.key, content_json: docOf(heading("Budget", "s_bud", "budget"), para("")) });
    expect((await call(d2.id, "s_bud", { mode: "draft", heading: "Budget", specKey: "budget" })).status).toBe(429);
    expect(mocks.claudeText).toHaveBeenCalledTimes(1);
  });
});
