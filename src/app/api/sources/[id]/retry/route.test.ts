import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), after: vi.fn(), ingest: vi.fn() }));
vi.mock("@vercel/blob", () => ({ list: mocks.list, del: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/sources/ingest", () => ({ ingestSource: mocks.ingest }));

import { resetMemoryStore } from "@/lib/documents/store";
import { sourceBlobPath, sourceBlobPrefix } from "@/lib/sources/blob-paths";
import { createSource, getSource, resetSourceStore, setSourceStatus, STALE_BUSY_MS } from "@/lib/sources/store";
import { POST } from "./route";

const T = "org:a";
const HOST = "https://abc.public.blob.vercel-storage.com/";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://x", { method: "POST" });

async function uploading() {
  const id = crypto.randomUUID();
  await createSource(T, "ann", { id, kind: "file", filename: "a.pdf", mime: "application/pdf", blob_pathname: sourceBlobPath(T, id, "a.pdf"), extraction_status: "uploading" });
  return id;
}

describe("POST /api/sources/[id]/retry", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
  });

  it("re-reads a source stuck mid-read", async () => {
    const s = await createSource(T, "ann", { kind: "note", title: "n", extracted_text: "t" });
    await setSourceStatus(T, s.id, "summarizing");
    // Long enough later that the read counts as stopped.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + STALE_BUSY_MS + 60_000);
      const res = await POST(req(), ctx(s.id));
      expect(res.status).toBe(200);
      expect((await getSource(T, s.id))?.extraction_status).toBe("pending");
      expect(mocks.after).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses while a read is under way, so two reads never race over the tables", async () => {
    const s = await createSource(T, "ann", { kind: "note", title: "n", extracted_text: "t" });
    await setSourceStatus(T, s.id, "ready");
    const [a, b] = await Promise.all([POST(req(), ctx(s.id)), POST(req(), ctx(s.id))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await setSourceStatus(T, s.id, "extracting");
    expect((await POST(req(), ctx(s.id))).status).toBe(409);
    expect((await getSource(T, s.id))?.extraction_status).toBe("extracting");
  });

  it("picks up a file whose upload reached storage but was never completed", async () => {
    const id = await uploading();
    const stored = `${sourceBlobPrefix(T, id)}a-Ab12.pdf`;
    mocks.list.mockResolvedValue({ blobs: [{ url: HOST + stored, pathname: stored, size: 99, uploadedAt: new Date() }], hasMore: false });
    const res = await POST(req(), ctx(id));
    expect(res.status).toBe(200);
    expect(await getSource(T, id)).toMatchObject({ extraction_status: "pending", blob_url: HOST + stored, bytes: 99, mime: "application/pdf" });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("refuses an upload that never reached storage", async () => {
    const id = await uploading();
    mocks.list.mockResolvedValue({ blobs: [], hasMore: false });
    expect((await POST(req(), ctx(id))).status).toBe(409);
    expect((await getSource(T, id))?.extraction_status).toBe("uploading");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("is 404 for another team's source", async () => {
    const s = await createSource("org:b", "bob", { kind: "note", title: "n", extracted_text: "t" });
    expect((await POST(req(), ctx(s.id))).status).toBe(404);
  });
});

describe("POST /api/sources/[id]/retry rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.SASHA_LIMIT_INGEST_USER = "1/1h";
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_INGEST_USER;
  });

  it("a 409 gives the read back; the 429 leaves the source as it was", async () => {
    const busy = await createSource(T, "ann", { kind: "note", title: "busy", extracted_text: "t" });
    await setSourceStatus(T, busy.id, "summarizing");
    expect((await POST(req(), ctx(busy.id))).status).toBe(409);
    const failed = await createSource(T, "ann", { kind: "note", title: "n", extracted_text: "t" });
    await setSourceStatus(T, failed.id, "error");
    expect((await POST(req(), ctx(failed.id))).status).toBe(200);
    await setSourceStatus(T, failed.id, "error");
    const res = await POST(req(), ctx(failed.id));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited", family: "ingest" });
    expect((await getSource(T, failed.id))?.extraction_status).toBe("error");
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });
});
