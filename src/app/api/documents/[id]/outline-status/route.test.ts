import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/catalog", () => ({ getType: async () => null }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { resetOutlineStatusCache } from "@/lib/sections/outline-status";
import { POST } from "./route";

const call = (id: string, body?: unknown) =>
  POST(new Request("http://x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ id }) });

describe("POST /api/documents/[id]/outline-status", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetOutlineStatusCache();
  });

  it("answers for an untyped document with an empty body, 400s bad bodies and 404s others", async () => {
    const d = await createDocument("org:a", "ann");
    const res = await call(d.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ typeKey: null, sections: [], model: false });
    expect((await call(d.id, { force: "yes" })).status).toBe(400);
    expect((await call("nope")).status).toBe(404);
    const other = await createDocument("org:b", "bob");
    expect((await call(other.id, {})).status).toBe(404);
  });
});
