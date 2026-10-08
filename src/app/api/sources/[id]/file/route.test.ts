import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { resetMemoryStore } from "@/lib/documents/store";
import { createSource, resetSourceStore, setSourceFile } from "@/lib/sources/store";
import { GET } from "./route";

const TOKEN = "vercel_blob_rw_AbC123_secret";
const OWN = "https://abc123.public.blob.vercel-storage.com/sources/x/a.pdf";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => GET(new Request(`http://x/api/sources/${id}/file`), ctx(id));

async function fileSource(team: string, blob_url: string) {
  const s = await createSource(team, "ann", { kind: "file", filename: "a.pdf", mime: "application/pdf", extraction_status: "ready" });
  // createSource doesn't take a blob URL; set it the way /api/upload/complete does.
  await setSourceFile(team, s.id, { blob_url, blob_pathname: "sources/x/a.pdf", bytes: 3, mime: "application/pdf" });
  return s.id;
}

describe("GET /api/sources/[id]/file", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
    resetMemoryStore();
    resetSourceStore();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("pdf", { status: 200, headers: { "content-length": "3" } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    vi.unstubAllGlobals();
  });

  it("serves the team's own file from its own store, with the token", async () => {
    const id = await fileSource("org:a", OWN);
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pdf");
    expect(fetchMock).toHaveBeenCalledWith(OWN, expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }));
  });

  it("404s another team's source without fetching", async () => {
    const id = await fileSource("org:b", OWN);
    expect((await get(id)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never fetches a blob URL on another host", async () => {
    for (const url of ["https://evil.example/a.pdf", "https://other9.public.blob.vercel-storage.com/a.pdf", "http://abc123.public.blob.vercel-storage.com/a.pdf"]) {
      const id = await fileSource("org:a", url);
      expect((await get(id)).status, url).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
