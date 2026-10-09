import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getE2eBlob, resetE2eBlobs } from "@/lib/e2e/blob-store";
import { matchesPresignedPath } from "@/lib/sources/blob-paths";
import { PUT } from "./route";

const put = (pathname: string | null, body: BodyInit, headers: Record<string, string> = {}) =>
  PUT(new Request(`http://x/api/e2e/blob${pathname === null ? "" : `?pathname=${encodeURIComponent(pathname)}`}`, { method: "PUT", body, headers }));

describe("PUT /api/e2e/blob", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SASHA_E2E_STUB_BLOB", "1");
    resetE2eBlobs();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores the bytes and answers like the Blob API, with a suffix upload/complete accepts", async () => {
    const path = "sources/0123456789abcdef/11111111-2222-3333-4444-555555555555/small.csv";
    const res = await put(path, "a,b\n1,2", { "x-content-type": "text/csv" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["contentDisposition", "contentType", "downloadUrl", "pathname", "url"]);
    expect(body.contentType).toBe("text/csv");
    expect(matchesPresignedPath(body.pathname, path)).toBe(true);
    expect(body.pathname).not.toBe(path);
    expect(body.url).toBe(`https://e2estore.public.blob.vercel-storage.com/${body.pathname}`);
    expect(new TextDecoder().decode(getE2eBlob(body.url)!.bytes)).toBe("a,b\n1,2");
  });

  it("400s without a pathname or with a parent segment", async () => {
    expect((await put(null, "x")).status).toBe(400);
    expect((await put("a/../b.txt", "x")).status).toBe(400);
  });

  it("is a 404 when the stub is off, and in production", async () => {
    vi.stubEnv("SASHA_E2E_STUB_BLOB", "");
    expect((await put("a.txt", "x")).status).toBe(404);
    vi.stubEnv("SASHA_E2E_STUB_BLOB", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect((await put("a.txt", "x")).status).toBe(404);
  });
});
