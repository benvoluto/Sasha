import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ after: vi.fn(), ingest: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/sources/ingest", () => ({ ingestSource: mocks.ingest }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { getSource, listDocumentSources, listSources, resetSourceStore } from "@/lib/sources/store";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://x/api/sources", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/sources", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
  });

  it("refuses private and local links before creating anything", async () => {
    for (const url of ["http://127.0.0.1/admin", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://localhost:3000/", "file:///etc/passwd"]) {
      const res = await post({ kind: "url", url });
      expect(res.status, url).toBe(400);
    }
    expect(await listSources("org:a")).toEqual([]);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("links a source to its document and files it in the document's folder", async () => {
    const doc = await createDocument("org:a", "ann");
    const res = await post({ kind: "note", title: "Call notes", text: "The council met on May 3.", document_id: doc.id });
    expect(res.status).toBe(201);
    const { source } = await res.json();
    const stored = await getSource("org:a", source.id);
    expect(stored).toMatchObject({ kind: "note", title: "Call notes", extracted_text: "The council met on May 3." });
    expect(stored?.folder_id).toBeTruthy();
    expect((await listDocumentSources("org:a", doc.id))?.map((s) => s.id)).toEqual([source.id]);

    // Reading starts after the response, for the caller's team.
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.ingest).toHaveBeenCalledWith("org:a", source.id, "ann");
  });

  it("404s another team's document", async () => {
    const doc = await createDocument("org:b", "bob");
    expect((await post({ kind: "note", title: "x", text: "y", document_id: doc.id })).status).toBe(404);
    expect(await listSources("org:a")).toEqual([]);
  });
});

describe("POST /api/sources rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    process.env.SASHA_LIMIT_INGEST_USER = "1/1h";
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_INGEST_USER;
  });

  it("counts a note as a source read; a refused link or folder costs nothing; the 429 creates nothing", async () => {
    expect((await post({ kind: "url", url: "http://127.0.0.1/" })).status).toBe(400);
    expect((await post({ kind: "note", title: "N", text: "t", document_id: crypto.randomUUID() })).status).toBe(404);
    expect((await post({ kind: "note", title: "One", text: "t" })).status).toBe(201);
    const res = await post({ kind: "note", title: "Two", text: "t" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited", family: "ingest", scope: "user" });
    expect((await listSources("org:a")).map((s) => s.title)).toEqual(["One"]);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });
});
