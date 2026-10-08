import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/catalog", () => ({ getType: async () => null }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { resetSourceStore } from "@/lib/sources/store";
import { applyGenerated } from "@/lib/suggestions/store";
import { GET, POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), ctx(id));

describe("/api/documents/[id]/suggestions", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
  });

  it("lists every suggestion with the stale flag", async () => {
    const d = await createDocument("org:a", "ann");
    await applyGenerated("org:a", "ann", d.id, "type", [{ kind: "source", label: "Report", reason: "", spec_ref: null }]);
    const res = await GET(new Request("http://x"), ctx(d.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ stale: true, generated_at: null, error: null });
    expect(body.suggestions.map((s: { label: string }) => s.label)).toEqual(["Report"]);
  });

  it("creates the person's own item (201), returns a duplicate (200), 400s bad bodies", async () => {
    const d = await createDocument("org:a", "ann");
    const created = await post(d.id, { kind: "data", label: "Revenue" });
    expect(created.status).toBe(201);
    expect((await created.json()).suggestion).toMatchObject({ origin: "user", state: "open", label: "Revenue" });
    const dup = await post(d.id, { kind: "data", label: "revenue" });
    expect(dup.status).toBe(200);
    const bad = await post(d.id, { kind: "web", label: "x" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBeTruthy();
    expect((await post(d.id, { kind: "data", label: "" })).status).toBe(400);
    expect((await post(d.id, { kind: "data", label: "x", extra: 1 })).status).toBe(400);
  });

  it("404s unknown and foreign documents", async () => {
    const other = await createDocument("org:b", "bob");
    expect((await GET(new Request("http://x"), ctx(other.id))).status).toBe(404);
    expect((await GET(new Request("http://x"), ctx("nope"))).status).toBe(404);
    expect((await post(other.id, { kind: "data", label: "x" })).status).toBe(404);
  });
});
