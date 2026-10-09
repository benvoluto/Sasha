import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ head: vi.fn(), after: vi.fn(), ingest: vi.fn() }));
vi.mock("@vercel/blob", () => ({ head: mocks.head }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/sources/ingest", () => ({ ingestSource: mocks.ingest }));

import { resetMemoryStore } from "@/lib/documents/store";
import { sourceBlobPath } from "@/lib/sources/blob-paths";
import { createSource, getSource, resetSourceStore } from "@/lib/sources/store";
import { POST } from "./route";

const T = "org:a";
const HOST = "https://abc.public.blob.vercel-storage.com/";

async function presigned(team = T, name = "a.pdf") {
  const id = crypto.randomUUID();
  const path = sourceBlobPath(team, id, name);
  await createSource(team, "ann", { id, kind: "file", filename: name, mime: "application/pdf", bytes: 5, blob_pathname: path, extraction_status: "uploading" });
  const stored = path.replace(/\.pdf$/, "-Ab12.pdf");
  return { id, report: { sourceId: id, url: HOST + stored, pathname: stored } };
}

const post = (uploads: unknown[]) => POST(new Request("http://x/api/upload/complete", { method: "POST", body: JSON.stringify({ uploads }) }));

describe("POST /api/upload/complete", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.head.mockResolvedValue({ size: 1234, contentType: "application/pdf" });
  });

  it("finalizes the good uploads even when another in the batch fails", async () => {
    const good = await presigned();
    const missing = await presigned(T, "b.pdf");
    const tampered = await presigned(T, "c.pdf");
    const otherTeam = await presigned("org:b", "d.pdf");
    mocks.head.mockImplementation(async (url: string) => {
      if (url === missing.report.url) throw new Error("not found");
      return { size: 1234, contentType: "application/pdf" };
    });

    const res = await post([good.report, missing.report, { ...tampered.report, url: "https://evil.example/x.pdf" }, otherTeam.report]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources.map((s: { id: string }) => s.id)).toEqual([good.id]);
    expect(body.failed.map((f: { sourceId: string }) => f.sourceId)).toEqual([missing.id, tampered.id, otherTeam.id]);
    expect(body.failed[2].error).toBe("Upload not found.");

    expect(await getSource(T, good.id)).toMatchObject({ extraction_status: "pending", blob_url: good.report.url, bytes: 1234 });
    expect((await getSource(T, missing.id))?.extraction_status).toBe("uploading");
    expect((await getSource("org:b", otherTeam.id))?.extraction_status).toBe("uploading");

    // Only the finalized source is read.
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.ingest.mock.calls.map((c) => c[1])).toEqual([good.id]);
  });

  it("refuses a path other than the presigned one", async () => {
    const u = await presigned();
    const elsewhere = u.report.pathname.replace(/a-Ab12\.pdf$/, "other.pdf");
    const body = await (await post([{ ...u.report, url: HOST + elsewhere, pathname: elsewhere }])).json();
    expect(body.sources).toEqual([]);
    expect(body.failed[0].error).toMatch(/doesn't match/);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("treats a repeated report as done, without reading the file again", async () => {
    const u = await presigned();
    await post([u.report]);
    mocks.after.mockReset();
    const body = await (await post([u.report])).json();
    expect(body).toMatchObject({ sources: [{ id: u.id }], failed: [] });
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe("POST /api/upload/complete rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.SASHA_LIMIT_INGEST_USER = "3/1h";
    resetMemoryStore();
    resetSourceStore();
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.head.mockResolvedValue({ size: 1234, contentType: "application/pdf" });
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_INGEST_USER;
  });

  it("counts one source read per file that starts, and refuses a batch that doesn't fit without recording any of it", async () => {
    const a = await presigned(T, "a.pdf");
    const b = await presigned(T, "b.pdf");
    const bad = await presigned(T, "c.pdf");
    // Two start (the same file reported twice is read once); the bad report costs nothing.
    const first = await post([a.report, a.report, b.report, { ...bad.report, url: "https://evil.example/x.pdf" }]);
    expect(first.status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.ingest.mock.calls.map((c) => c[1])).toEqual([a.id, b.id]);

    const c = await presigned(T, "d.pdf");
    const d = await presigned(T, "e.pdf");
    const res = await post([c.report, d.report]);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ code: "rate_limited", scope: "user", family: "ingest", retry_after_seconds: expect.any(Number), error: expect.stringMatching(/^You've used your 3 source reads for this hour/) });
    expect((await getSource(T, c.id))?.extraction_status).toBe("uploading");
    expect((await getSource(T, d.id))?.extraction_status).toBe("uploading");
    expect(mocks.after).toHaveBeenCalledTimes(1);

    // One still fits, and a repeated report of a finished upload costs nothing.
    const ok = await post([c.report, a.report]);
    expect(ok.status).toBe(200);
    expect((await getSource(T, c.id))?.extraction_status).toBe("pending");
    expect((await post([a.report])).status).toBe(200);
  });
});
