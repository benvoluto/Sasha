import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => ({ list: mocks.list, del: mocks.del }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { resetMemoryStore } from "@/lib/documents/store";
import { sourceBlobPath, sourceBlobPrefix } from "@/lib/sources/blob-paths";
import { createSource, getSource, resetSourceStore } from "@/lib/sources/store";
import { DELETE } from "./route";

const HOST = "https://abc.public.blob.vercel-storage.com/";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://x", { method: "DELETE" });

describe("DELETE /api/sources/[id]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    resetMemoryStore();
    resetSourceStore();
    mocks.list.mockReset();
    mocks.del.mockReset();
  });

  it("deletes every file the source stored, including one an unfinished upload left", async () => {
    const id = crypto.randomUUID();
    await createSource("org:a", "ann", { id, kind: "file", filename: "a.pdf", blob_pathname: sourceBlobPath("org:a", id, "a.pdf"), extraction_status: "uploading" });
    const stray = `${sourceBlobPrefix("org:a", id)}a-Xy12.pdf`;
    mocks.list.mockResolvedValue({ blobs: [{ url: HOST + stray, pathname: stray, size: 1, uploadedAt: new Date() }], hasMore: false });
    const res = await DELETE(req(), ctx(id));
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: sourceBlobPrefix("org:a", id) }));
    expect(mocks.del).toHaveBeenCalledWith([HOST + stray]);
    expect(await getSource("org:a", id)).toBeNull();
  });

  it("is 404 for another team's source and touches no files", async () => {
    const s = await createSource("org:b", "bob", { kind: "note", title: "n", extracted_text: "t" });
    expect((await DELETE(req(), ctx(s.id))).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(await getSource("org:b", s.id)).not.toBeNull();
  });
});
