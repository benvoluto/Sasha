import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), configured: { value: true } }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/sections/generate", () => ({ generateSection: mocks.generate }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeConfigured: () => mocks.configured.value,
}));

import { ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const call = (body: unknown, id = ID, sectionId = "s_abc12345") =>
  POST(new Request(`http://x/api/documents/${id}/sections/${sectionId}/generate`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id, sectionId }) });

describe("POST /api/documents/[id]/sections/[sectionId]/generate", () => {
  beforeEach(() => {
    mocks.generate.mockReset();
    mocks.configured.value = true;
  });

  it("passes the parsed request through and returns the response", async () => {
    const response = { markdown: "Hi", task: "draft.section", sourcesUsed: 0, section: { section_id: "s_abc12345" } };
    mocks.generate.mockResolvedValue({ ok: true, response });
    const res = await call({ mode: "draft", heading: "Budget" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(response);
    expect(mocks.generate).toHaveBeenCalledWith({ teamId: "org:a", agent: "ann", documentId: ID, sectionId: "s_abc12345", req: { mode: "draft", heading: "Budget", level: 2, body: "" } });
  });

  it("404s bad ids, 503s without Claude, 400s invalid bodies", async () => {
    expect((await call({ mode: "draft", heading: "B" }, "nope")).status).toBe(404);
    expect((await call({ mode: "draft", heading: "B" }, ID, "bad id")).status).toBe(404);
    const bad = await call({ mode: "rewrite", heading: "B", body: "" , preset: "concise" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Nothing to rewrite/);
    mocks.configured.value = false;
    const off = await call({ mode: "draft", heading: "B" });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "Claude is not configured." });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("maps typed failures and model errors to statuses", async () => {
    mocks.generate.mockResolvedValueOnce({ ok: false, code: "static", status: 409, error: "This section is fixed text; edit it directly." });
    expect((await call({ mode: "draft", heading: "B" })).status).toBe(409);
    mocks.generate.mockResolvedValueOnce({ ok: false, code: "notes_required", status: 400, error: "No notes" });
    expect((await call({ mode: "draft_from_notes", heading: "B" })).status).toBe(400);
    mocks.generate.mockRejectedValueOnce(new ModelRefusalError(null));
    expect((await call({ mode: "draft", heading: "B" })).status).toBe(422);
    mocks.generate.mockRejectedValueOnce(new ModelTruncatedError());
    expect((await call({ mode: "draft", heading: "B" })).status).toBe(422);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.generate.mockRejectedValueOnce(new Error("network"));
    const res = await call({ mode: "draft", heading: "B" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Drafting failed. Try again." });
  });
});
