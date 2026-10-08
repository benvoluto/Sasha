import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ permission: { last: "" } }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => {
    mocks.permission.last = permission;
    return { teamId: "org:a", agent: "ann" };
  },
}));

import { createDocument, getDocument, resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { POST } from "./route";

const post = (id: string, body?: unknown) =>
  POST(new Request("http://x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ id }) });

describe("POST /api/documents/[id]/classify/dismiss", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("counts the dismissal and returns the view without bumping updated_at", async () => {
    const d = await createDocument("org:a", "ann");
    await post(d.id, { key: "proposal" });
    const res = await post(d.id, { key: "proposal" });
    expect(mocks.permission.last).toBe(PERMISSIONS.documentWrite);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ view: { state: { last: null, dismissals: { proposal: 2 } } } });
    expect((await getDocument("org:a", d.id))!.updated_at).toBe(d.updated_at);
  });

  it("400s bad bodies and 404s unknown or foreign documents", async () => {
    const d = await createDocument("org:a", "ann");
    expect((await post(d.id)).status).toBe(400);
    expect((await post(d.id, { key: "" })).status).toBe(400);
    expect((await post(d.id, { key: "proposal", more: true })).status).toBe(400);
    expect((await post("nope", { key: "proposal" })).status).toBe(404);
    const other = await createDocument("org:b", "bob");
    expect((await post(other.id, { key: "proposal" })).status).toBe(404);
    expect((await getDocument("org:b", other.id))!.classifier_state.dismissals).toEqual({});
  });
});
