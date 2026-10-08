import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { GET as LIST } from "../route";
import { GET, PUT } from "./route";

const ctx = (id: string, sectionId = "s_1") => ({ params: Promise.resolve({ id, sectionId }) });
const put = (id: string, body: unknown, sectionId = "s_1") => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx(id, sectionId));

describe("section notes routes", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("reads a blank row, saves notes, and lists rows", async () => {
    const d = await createDocument("org:a", "ann");
    const blank = await GET(new Request("http://x"), ctx(d.id));
    expect((await blank.json()).section).toMatchObject({ section_id: "s_1", notes: "", status: "empty" });

    const saved = await put(d.id, { notes: "Call the council", specKey: "summary" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).section).toMatchObject({ notes: "Call the council", spec_key: "summary" });

    const list = await LIST(new Request("http://x"), { params: Promise.resolve({ id: d.id }) });
    expect((await list.json()).sections.map((s: { section_id: string }) => s.section_id)).toEqual(["s_1"]);
  });

  it("400s invalid bodies and 404s other teams' documents and bad ids", async () => {
    const d = await createDocument("org:a", "ann");
    expect((await put(d.id, { notes: 5 })).status).toBe(400);
    expect((await put(d.id, { notes: "x", extra: true })).status).toBe(400);
    const other = await createDocument("org:b", "bob");
    expect((await put(other.id, { notes: "x" })).status).toBe(404);
    expect((await GET(new Request("http://x"), ctx(other.id))).status).toBe(404);
    expect((await GET(new Request("http://x"), ctx("nope"))).status).toBe(404);
    expect((await GET(new Request("http://x"), ctx(d.id, "bad id"))).status).toBe(404);
    expect((await LIST(new Request("http://x"), { params: Promise.resolve({ id: other.id }) })).status).toBe(404);
  });
});
