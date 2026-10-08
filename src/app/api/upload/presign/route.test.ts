import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { SOURCE_BLOB_PATH_RE, sourceBlobPath } from "@/lib/sources/blob-paths";
import { createFolder, getSource, listDocumentSources, listSources, resetSourceStore } from "@/lib/sources/store";
import { POST } from "./route";

const file = (over: Partial<{ name: string; size: number; type: string }> = {}) => ({ name: "Plan v2.pdf", size: 1234, type: "application/pdf", ...over });
const presign = (body: unknown) => POST(new Request("http://x/api/upload/presign", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/upload/presign", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
  });

  it("creates an uploading source per file at its team-scoped path", async () => {
    const res = await presign({ files: [file(), file({ name: "notes.md", type: "" })] });
    expect(res.status).toBe(200);
    const { uploads, folder_id } = await res.json();
    expect(folder_id).toBeNull();
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      const s = await getSource("org:a", u.sourceId);
      expect(s).toMatchObject({ kind: "file", extraction_status: "uploading", filename: u.fileName, folder_id: null });
      expect(u.fields.blobPath).toBe(sourceBlobPath("org:a", u.sourceId, u.fileName));
      expect(u.fields.blobPath).toMatch(SOURCE_BLOB_PATH_RE);
      expect(s?.blob_pathname).toBe(u.fields.blobPath);
    }
    expect(uploads[1].fields.contentType).toBe("text/markdown");
  });

  it("files into a document's folder and links the sources to it", async () => {
    const doc = await createDocument("org:a", "ann");
    const { uploads, folder_id } = await (await presign({ files: [file()], document_id: doc.id })).json();
    expect(folder_id).toBeTruthy();
    expect((await getSource("org:a", uploads[0].sourceId))?.folder_id).toBe(folder_id);
    expect((await listDocumentSources("org:a", doc.id))?.map((s) => s.id)).toEqual([uploads[0].sourceId]);
  });

  it("404s another team's document or folder and creates nothing", async () => {
    const doc = await createDocument("org:b", "bob");
    const folder = await createFolder("org:b", "bob", { name: "Theirs" });
    if (!folder.ok) throw new Error("folder not created");
    expect((await presign({ files: [file()], document_id: doc.id })).status).toBe(404);
    expect((await presign({ files: [file()], folder_id: folder.folder.id })).status).toBe(404);
    expect(await listSources("org:a")).toEqual([]);
    expect(await listSources("org:b")).toEqual([]);
  });

  it("rejects unsupported, empty and oversized files", async () => {
    expect((await presign({ files: [file({ name: "a.zip", type: "application/zip" })] })).status).toBe(400);
    expect((await presign({ files: [file({ size: 0 })] })).status).toBe(400);
    expect((await presign({ files: [file({ size: 51 * 1024 * 1024 })] })).status).toBe(400);
    expect((await presign({ files: [] })).status).toBe(400);
  });
});
