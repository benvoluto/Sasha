import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => ({ list: mocks.list, del: mocks.del }));

import { sourceBlobPrefix } from "./blob-paths";
import { deleteSourceBlobs, findPresignedUpload } from "./blobs";

const T = "org:a";
const ID = "11111111-2222-4333-8444-555555555555";
const HOST = "https://abc.public.blob.vercel-storage.com/";
const blob = (pathname: string, uploadedAt = "2026-01-01T00:00:00Z") => ({ url: HOST + pathname, downloadUrl: HOST + pathname, pathname, size: 5, uploadedAt: new Date(uploadedAt) });

describe("source blobs", () => {
  beforeEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    mocks.list.mockReset();
    mocks.del.mockReset();
  });

  it("deletes every file under the source's prefix, across pages, plus the row's own URL", async () => {
    const prefix = sourceBlobPrefix(T, ID);
    mocks.list
      .mockResolvedValueOnce({ blobs: [blob(`${prefix}r-old.pdf`)], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ blobs: [blob(`${prefix}r-new.pdf`)], hasMore: false });
    await deleteSourceBlobs(T, ID, [HOST + `${prefix}r-new.pdf`, null, "https://evil.example/x.pdf"]);
    expect(mocks.list).toHaveBeenNthCalledWith(1, { prefix, cursor: undefined });
    expect(mocks.list).toHaveBeenNthCalledWith(2, { prefix, cursor: "c1" });
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect([...mocks.del.mock.calls[0][0]].sort()).toEqual([HOST + `${prefix}r-new.pdf`, HOST + `${prefix}r-old.pdf`]);
  });

  it("removes a file whose upload was never completed (the row has no URL)", async () => {
    const prefix = sourceBlobPrefix(T, ID);
    mocks.list.mockResolvedValue({ blobs: [blob(`${prefix}a-Xy12.pdf`)], hasMore: false });
    await deleteSourceBlobs(T, ID, [null]);
    expect(mocks.del).toHaveBeenCalledWith([HOST + `${prefix}a-Xy12.pdf`]);
  });

  it("never throws, and still deletes the known URL when listing fails", async () => {
    mocks.list.mockRejectedValue(new Error("down"));
    mocks.del.mockRejectedValue(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deleteSourceBlobs(T, ID, [HOST + "sources/x/y/z.pdf"])).resolves.toBeUndefined();
    expect(mocks.del).toHaveBeenCalledWith([HOST + "sources/x/y/z.pdf"]);
    spy.mockRestore();
  });

  it("finds the newest upload at presign's path, ignoring other files", async () => {
    const prefix = sourceBlobPrefix(T, ID);
    mocks.list.mockResolvedValue({
      blobs: [blob(`${prefix}a-Old1.pdf`, "2026-01-01T00:00:00Z"), blob(`${prefix}a-New2.pdf`, "2026-01-02T00:00:00Z"), blob(`${prefix}other.pdf`, "2026-01-03T00:00:00Z")],
      hasMore: false,
    });
    expect((await findPresignedUpload(T, ID, `${prefix}a.pdf`))?.pathname).toBe(`${prefix}a-New2.pdf`);
    mocks.list.mockResolvedValue({ blobs: [], hasMore: false });
    expect(await findPresignedUpload(T, ID, `${prefix}a.pdf`)).toBeNull();
  });
});
