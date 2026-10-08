import { describe, expect, it } from "vitest";
import { blobAuthHeaders, blobStoreId, isOwnBlobUrl } from "./blob-host";

const TOKEN = "vercel_blob_rw_AbC123xyz_secretsecret";

describe("blob host checks", () => {
  it("reads the store id from the token", () => {
    expect(blobStoreId(TOKEN)).toBe("abc123xyz");
    expect(blobStoreId("garbage")).toBeNull();
    expect(blobStoreId(undefined)).toBeNull();
  });

  it("accepts only the store's own host over https", () => {
    expect(isOwnBlobUrl("https://abc123xyz.public.blob.vercel-storage.com/sources/a.pdf", TOKEN)).toBe(true);
    expect(isOwnBlobUrl("https://abc123xyz.private.blob.vercel-storage.com/sources/a.pdf", TOKEN)).toBe(true);
    expect(isOwnBlobUrl("https://someoneelse.public.blob.vercel-storage.com/a.pdf", TOKEN)).toBe(false);
    expect(isOwnBlobUrl("http://abc123xyz.public.blob.vercel-storage.com/a.pdf", TOKEN)).toBe(false);
    expect(isOwnBlobUrl("https://abc123xyz.public.blob.vercel-storage.com.evil.com/a.pdf", TOKEN)).toBe(false);
    expect(isOwnBlobUrl("https://evil.com/?abc123xyz.public.blob.vercel-storage.com", TOKEN)).toBe(false);
    expect(isOwnBlobUrl("https://user@abc123xyz.public.blob.vercel-storage.com/a.pdf", TOKEN)).toBe(false);
    expect(isOwnBlobUrl("not a url", TOKEN)).toBe(false);
  });

  it("falls back to any Vercel Blob host without a token", () => {
    expect(isOwnBlobUrl("https://whatever.public.blob.vercel-storage.com/a", "")).toBe(true);
    expect(isOwnBlobUrl("https://evil.com/a", "")).toBe(false);
  });

  it("only attaches the token for the store's own host", () => {
    const prev = process.env.BLOB_READ_WRITE_TOKEN;
    process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
    try {
      expect(blobAuthHeaders("https://abc123xyz.public.blob.vercel-storage.com/a")).toEqual({ Authorization: `Bearer ${TOKEN}` });
      expect(blobAuthHeaders("https://evil.com/a")).toEqual({});
      expect(blobAuthHeaders("https://other.public.blob.vercel-storage.com/a")).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = prev;
    }
  });
});
