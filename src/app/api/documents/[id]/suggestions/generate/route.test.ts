import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/llm/claude")>()), claudeConfigured: () => false }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { resetSuggestionGenerator } from "@/lib/suggestions/generate";
import { POST } from "./route";

const call = (id: string, body?: unknown) =>
  POST(new Request("http://x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ id }) });

describe("POST /api/documents/[id]/suggestions/generate", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSuggestionGenerator();
  });

  it("writes a typed document's items without Claude, 400s bad bodies, 404s others", async () => {
    const d = await createDocument("org:a", "ann", { type_key: "proposal" });
    const res = await call(d.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ran: false, stale: false, error: null });
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect((await call(d.id, { force: "yes" })).status).toBe(400);
    expect((await call("nope")).status).toBe(404);
    const other = await createDocument("org:b", "bob");
    expect((await call(other.id, {})).status).toBe(404);
  });
});
