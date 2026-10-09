import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeJson: vi.fn(), configured: { on: true }, permission: { last: "" } }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => {
    mocks.permission.last = permission;
    return { teamId: "org:a", agent: "ann", userId: "u1", orgId: "a", permissions: [] };
  },
}));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeJson: mocks.claudeJson,
  claudeConfigured: () => mocks.configured.on,
}));
vi.mock("@/catalog", async () => {
  const { fileTypes } = await import("@/catalog/files");
  return { listTypes: async () => fileTypes().map((definition) => ({ definition, origin: "file", enabled: true, overridden: false, updated_at: null })) };
});

import { createDocument, getDocument, resetMemoryStore } from "@/lib/documents/store";
import { ModelDeadlineError, ModelRefusalError } from "@/lib/llm/claude";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { TELL_ME_ADDENDUM } from "@/lib/tell-me/prompt";
import { POST } from "./route";

const post = (id: string, body?: unknown) =>
  POST(new Request("http://x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ id }) });
const reply = (data: unknown) => mocks.claudeJson.mockResolvedValue({ data, usage: {} });

describe("POST /api/documents/[id]/start-from-prompt", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    mocks.configured.on = true;
    mocks.claudeJson.mockReset();
    reply({ candidates: [{ key: "general-report", confidence: 0.9, why: "a report for a funder" }], freeform: false, title: "  Reading program progress report  " });
  });

  it("picks a confident type and a title, and stores nothing", async () => {
    const d = await createDocument("org:a", "ann", { title: "Draft" });
    const res = await post(d.id, { prompt: "A progress report for the Hartley Foundation on our reading program" });
    expect(mocks.permission.last).toBe(PERMISSIONS.documentWrite);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      typeKey: "general-report",
      title: "Reading program progress report",
      why: "a report for a funder",
      candidates: [{ key: "general-report", confidence: 0.9, why: "a report for a funder" }],
    });
    const { task, system, user, documentId } = mocks.claudeJson.mock.calls[0][0];
    expect(task).toBe("classify.prompt");
    expect(system.endsWith(TELL_ME_ADDENDUM)).toBe(true);
    expect(user).toContain('<request title="Draft">');
    expect(user).toContain("\nA progress report for the Hartley Foundation on our reading program\n</request>");
    expect(documentId).toBe(d.id);
    const after = await getDocument("org:a", d.id);
    expect(after?.type_key).toBeNull();
    expect(after?.updated_at).toBe(d.updated_at);
  });

  it("gives no type for a freeform request or a weak candidate, and an empty title as null", async () => {
    const d = await createDocument("org:a", "ann");
    reply({ candidates: [{ key: "general-report", confidence: 0.9, why: "x" }], freeform: true, title: "" });
    expect(await (await post(d.id, { prompt: "a poem for my mother" })).json()).toMatchObject({ typeKey: null, title: null });
    reply({ candidates: [{ key: "general-report", confidence: 0.2, why: "maybe" }], freeform: false, title: "Notes" });
    expect(await (await post(d.id, { prompt: "some kind of document" })).json()).toMatchObject({ typeKey: null, title: "Notes", why: "maybe" });
  });

  it("filters out keys that aren't enabled types", async () => {
    const d = await createDocument("org:a", "ann");
    reply({ candidates: [{ key: "made-up", confidence: 0.95, why: "invented" }, { key: "general-report", confidence: 0.6, why: "real" }], freeform: false, title: "T".repeat(200) });
    const body = await (await post(d.id, { prompt: "a report" })).json();
    expect(body.typeKey).toBe("general-report");
    expect(body.candidates.map((c: { key: string }) => c.key)).toEqual(["general-report"]);
    expect(body.title).toHaveLength(120);
  });

  it("400s bad bodies and 404s unknown or foreign documents, without a model call", async () => {
    const d = await createDocument("org:a", "ann");
    expect((await post(d.id)).status).toBe(400);
    const short = await post(d.id, { prompt: "  a " });
    expect(short.status).toBe(400);
    expect((await short.json()).error).toBe("Say a little more about the document.");
    expect((await post(d.id, { prompt: "x".repeat(1801) })).status).toBe(400);
    expect((await post(d.id, { prompt: "a report", extra: 1 })).status).toBe(400);
    expect((await post("nope", { prompt: "a report" })).status).toBe(404);
    const other = await createDocument("org:b", "bob");
    expect((await post(other.id, { prompt: "a report" })).status).toBe(404);
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });

  it("503s when Claude isn't configured", async () => {
    mocks.configured.on = false;
    const d = await createDocument("org:a", "ann");
    const res = await post(d.id, { prompt: "a report" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/can't start from a prompt/);
  });

  it("maps model failures to 422, 504 and 502", async () => {
    const d = await createDocument("org:a", "ann");
    mocks.claudeJson.mockRejectedValueOnce(new ModelRefusalError(null));
    expect((await post(d.id, { prompt: "a report" })).status).toBe(422);
    mocks.claudeJson.mockRejectedValueOnce(new ModelDeadlineError());
    const slow = await post(d.id, { prompt: "a report" });
    expect(slow.status).toBe(504);
    expect((await slow.json()).error).toMatch(/Try again\.$/);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.claudeJson.mockRejectedValueOnce(new Error("boom"));
    const broken = await post(d.id, { prompt: "a report" });
    expect(broken.status).toBe(502);
    expect((await broken.json()).error).toBe("Sasha couldn't read that request. Try again.");
    spy.mockRestore();
  });
});

describe("POST /api/documents/[id]/start-from-prompt rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    process.env.SASHA_LIMIT_LIGHT_USER = "1/10m";
    resetMemoryStore();
    mocks.configured.on = true;
    mocks.claudeJson.mockReset();
    reply({ candidates: [], freeform: true, title: "" });
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_LIGHT_USER;
  });

  it("answers the light allowance's refusal with a RateLimitedBody", async () => {
    const d = await createDocument("org:a", "ann");
    expect((await post(d.id, { prompt: "a report" })).status).toBe(200);
    const res = await post(d.id, { prompt: "a report" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ code: "rate_limited", family: "light", error: expect.any(String) });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });
});
