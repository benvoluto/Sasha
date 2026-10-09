import { beforeEach, describe, expect, it } from "vitest";
import { isOwnBlobUrl } from "@/lib/blob-host";
import { E2E_BLOB_ORIGIN, e2eBlobUrl, getE2eBlob, headE2eBlob, putE2eBlob, resetE2eBlobs, withRandomSuffix } from "./blob-store";

const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => resetE2eBlobs());

describe("e2e blob store", () => {
  it("stores under the fake store's URL, which the e2e token's store check accepts", () => {
    const put = putE2eBlob("/sources/abc/file.csv", bytes("a,b\n1,2"), "text/csv");
    expect(put).toEqual({ url: `${E2E_BLOB_ORIGIN}/sources/abc/file.csv`, pathname: "sources/abc/file.csv", contentType: "text/csv", size: 7 });
    expect(isOwnBlobUrl(put.url, "vercel_blob_rw_e2estore_notarealsecret")).toBe(true);
    expect(isOwnBlobUrl(put.url, "vercel_blob_rw_realstore_secret")).toBe(false);
  });

  it("reads back by URL (ignoring a query) and heads like @vercel/blob", () => {
    const { url } = putE2eBlob("a/b.pdf", bytes("%PDF-1.4"), "application/pdf");
    expect(new TextDecoder().decode(getE2eBlob(`${url}?download=1`)!.bytes)).toBe("%PDF-1.4");
    const head = headE2eBlob(url);
    expect(head).toMatchObject({ url, size: 8, contentType: "application/pdf" });
    expect(head.uploadedAt).toBeInstanceOf(Date);
  });

  it("throws on head and returns null on get for a missing blob; reset clears", () => {
    const { url } = putE2eBlob("x.txt", bytes("x"), "text/plain");
    resetE2eBlobs();
    expect(getE2eBlob(url)).toBeNull();
    expect(() => headE2eBlob(e2eBlobUrl("x.txt"))).toThrow();
  });

  it("adds a store-style suffix before the extension", () => {
    expect(withRandomSuffix("sources/t/u/report.final.pdf", "abc123")).toBe("sources/t/u/report.final-abc123.pdf");
    expect(withRandomSuffix("sources/t/u/README", "abc123")).toBe("sources/t/u/README-abc123");
    expect(withRandomSuffix("sources/t.d/u/.env", "abc123")).toBe("sources/t.d/u/.env-abc123");
    expect(withRandomSuffix("a/b.csv")).toMatch(/^a\/b-[0-9a-f]{24}\.csv$/);
  });
});
