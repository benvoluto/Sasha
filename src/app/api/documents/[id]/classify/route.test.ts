import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeJson: vi.fn(), permission: { last: "" } }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => {
    mocks.permission.last = permission;
    return { teamId: "org:a", agent: "ann" };
  },
}));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeJson: mocks.claudeJson,
  claudeConfigured: () => true,
}));
vi.mock("@/catalog", async () => {
  const { fileTypes } = await import("@/catalog/files");
  return { listTypes: async () => fileTypes().map((definition) => ({ definition, origin: "file", enabled: true, overridden: false, updated_at: null })) };
});

import { resetClassifierMemory } from "@/lib/classifier/classify";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { docOf, para } from "@/lib/sections/test-fixtures";
import { GET, POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body?: unknown) =>
  POST(new Request("http://x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), ctx(id));
const get = (id: string) => GET(new Request("http://x"), ctx(id));
const longDoc = () => docOf(para(Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")));

describe("/api/documents/[id]/classify", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetClassifierMemory();
    mocks.claudeJson.mockReset().mockResolvedValue({
      data: { candidates: [{ key: "proposal", confidence: 0.8, why: "asks for approval" }], freeform: false },
      usage: {},
    });
  });

  it("POST runs and returns the view, then 429s inside the window", async () => {
    const d = await createDocument("org:a", "ann", { content_json: longDoc() });
    const res = await post(d.id, { trigger: "content" });
    expect(mocks.permission.last).toBe(PERMISSIONS.documentWrite);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ran: true, view: { type_confidence: 0.8, state: { last: { trigger: "content" } } } });
    const again = await post(d.id, { trigger: "content" });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await again.json()).toMatchObject({ retryAfterMs: expect.any(Number), view: { type_confidence: 0.8 } });
  });

  it("POST 400s bad bodies and 404s unknown or foreign documents", async () => {
    const d = await createDocument("org:a", "ann", { content_json: longDoc() });
    expect((await post(d.id)).status).toBe(400);
    expect((await post(d.id, { trigger: "whenever" })).status).toBe(400);
    expect((await post(d.id, { trigger: "content", extra: 1 })).status).toBe(400);
    expect((await post("nope", { trigger: "content" })).status).toBe(404);
    const other = await createDocument("org:b", "bob", { content_json: longDoc() });
    expect((await post(other.id, { trigger: "content" })).status).toBe(404);
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });

  it("POST rejects `force`: a request body can't skip the 2-minute gate", async () => {
    const d = await createDocument("org:a", "ann", { content_json: longDoc() });
    expect((await post(d.id, { trigger: "manual" })).status).toBe(200);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    expect((await post(d.id, { trigger: "manual", force: true })).status).toBe(400);
    expect((await post(d.id, { trigger: "manual" })).status).toBe(429);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("GET returns the view with read permission, 404 for others", async () => {
    const d = await createDocument("org:a", "ann");
    const res = await get(d.id);
    expect(mocks.permission.last).toBe(PERMISSIONS.documentRead);
    expect(await res.json()).toEqual({
      view: { type_key: null, type_source: null, type_confidence: null, last_classified_at: null, state: { last: null, dismissals: {}, words_at_last_run: 0 } },
    });
    const other = await createDocument("org:b", "bob");
    expect((await get(other.id)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});

describe("POST /api/documents/[id]/classify rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    process.env.SASHA_LIMIT_LIGHT_USER = "1/10m";
    resetMemoryStore();
    resetClassifierMemory();
    mocks.claudeJson.mockReset().mockResolvedValue({ data: { candidates: [{ key: "proposal", confidence: 0.8, why: "asks" }], freeform: false }, usage: {} });
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_LIGHT_USER;
  });

  it("answers the light allowance's refusal with a RateLimitedBody and Retry-After", async () => {
    const a = await createDocument("org:a", "ann", { content_json: longDoc() });
    const b = await createDocument("org:a", "ann", { content_json: longDoc() });
    expect((await post(a.id, { trigger: "content" })).status).toBe(200);
    const res = await post(b.id, { trigger: "content" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ code: "rate_limited", scope: "user", family: "light", error: expect.stringMatching(/^You've used your 1 background check for the last 10 minutes/) });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });
});
