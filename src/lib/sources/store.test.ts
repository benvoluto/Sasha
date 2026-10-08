import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, deleteDocument, resetMemoryStore } from "@/lib/documents/store";
import {
  createFolder,
  createSource,
  deleteFolder,
  deleteSource,
  ensureDocumentFolder,
  getFolder,
  getSource,
  linkSource,
  listDocumentSources,
  listFolders,
  listPassages,
  listSources,
  replacePassages,
  reportedStatus,
  resetSourceStore,
  setExtraction,
  setSourceStatus,
  setSummary,
  setTitleIfMissing,
  targetFolder,
  unlinkSource,
  updateFolder,
  updateSource,
  STALE_BUSY_MS,
  STALE_UPLOAD_MS,
  toSummary,
  wouldCycle,
} from "./store";

const A = "org:a";
const B = "org:b";
const MISSING = "00000000-0000-4000-8000-000000000000";

async function folder(team: string, name: string, parent_id: string | null = null) {
  const r = await createFolder(team, "ann", { name, parent_id });
  if (!r.ok) throw new Error(r.reason);
  return r.folder;
}

const passage = (idx: number) => ({ id: `S1.P${idx}`, idx, page: 1, start_offset: idx * 10, end_offset: idx * 10 + 9, text: `passage ${idx}` });

describe("source store (in memory)", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
  });

  describe("folders", () => {
    it("scopes folders to a team", async () => {
      const f = await folder(A, "Research");
      expect((await listFolders(A)).map((x) => x.name)).toEqual(["Research"]);
      expect(await listFolders(B)).toEqual([]);
      expect(await getFolder(B, f.id)).toBeNull();
      expect(await updateFolder(B, f.id, { name: "Mine" })).toEqual({ ok: false, reason: "not_found" });
      expect(await deleteFolder(B, f.id)).toBe(false);
      expect(await getFolder(A, f.id)).not.toBeNull();
    });

    it("refuses a parent from another team", async () => {
      const theirs = await folder(B, "Theirs");
      expect(await createFolder(A, "ann", { name: "x", parent_id: theirs.id })).toEqual({ ok: false, reason: "parent_not_found" });
      const mine = await folder(A, "Mine");
      expect(await updateFolder(A, mine.id, { parent_id: theirs.id })).toEqual({ ok: false, reason: "parent_not_found" });
    });

    it("renames and moves, and rejects cycles", async () => {
      const top = await folder(A, "Top");
      const mid = await folder(A, "Mid", top.id);
      const leaf = await folder(A, "Leaf", mid.id);
      expect(await updateFolder(A, top.id, { parent_id: leaf.id })).toEqual({ ok: false, reason: "cycle" });
      expect(await updateFolder(A, top.id, { parent_id: top.id })).toEqual({ ok: false, reason: "cycle" });
      const moved = await updateFolder(A, leaf.id, { parent_id: null, name: "Leaf 2" });
      expect(moved).toMatchObject({ ok: true, folder: { parent_id: null, name: "Leaf 2" } });
      // Now that Leaf is out from under Top, Top can go inside it.
      expect(await updateFolder(A, top.id, { parent_id: leaf.id })).toMatchObject({ ok: true });
    });

    it("wouldCycle tolerates an existing loop", () => {
      const folders = [
        { id: "a", parent_id: "b" },
        { id: "b", parent_id: "a" },
      ];
      expect(wouldCycle(folders, "c", "a")).toBe(true);
      expect(wouldCycle([{ id: "a", parent_id: null }], "c", "a")).toBe(false);
    });

    it("deleting a folder deletes subfolders and moves their sources to the root", async () => {
      const top = await folder(A, "Top");
      const sub = await folder(A, "Sub", top.id);
      const other = await folder(A, "Other");
      const s1 = await createSource(A, "ann", { kind: "note", title: "n1", folder_id: top.id });
      const s2 = await createSource(A, "ann", { kind: "note", title: "n2", folder_id: sub.id });
      const s3 = await createSource(A, "ann", { kind: "note", title: "n3", folder_id: other.id });
      expect(await deleteFolder(A, top.id)).toBe(true);
      expect((await listFolders(A)).map((f) => f.name)).toEqual(["Other"]);
      expect((await getSource(A, s1.id))?.folder_id).toBeNull();
      expect((await getSource(A, s2.id))?.folder_id).toBeNull();
      expect((await getSource(A, s3.id))?.folder_id).toBe(other.id);
    });
  });

  describe("document folders", () => {
    it("ensureDocumentFolder is idempotent and team-scoped", async () => {
      const doc = await createDocument(A, "ann", { title: "Grant proposal" });
      const f1 = await ensureDocumentFolder(A, "ann", doc.id);
      const f2 = await ensureDocumentFolder(A, "bob", doc.id);
      expect(f1).not.toBeNull();
      expect(f2?.id).toBe(f1?.id);
      expect(f1).toMatchObject({ name: "Grant proposal", document_id: doc.id, parent_id: null });
      expect(await listFolders(A)).toHaveLength(1);
      expect(await ensureDocumentFolder(B, "eve", doc.id)).toBeNull();
      expect(await ensureDocumentFolder(A, "ann", MISSING)).toBeNull();
    });

    it("names an untitled document's folder", async () => {
      const doc = await createDocument(A, "ann");
      expect((await ensureDocumentFolder(A, "ann", doc.id))?.name).toBe("Untitled document");
    });

    it("recreates the folder after it was deleted", async () => {
      const doc = await createDocument(A, "ann");
      const f1 = await ensureDocumentFolder(A, "ann", doc.id);
      await deleteFolder(A, f1!.id);
      const f2 = await ensureDocumentFolder(A, "ann", doc.id);
      expect(f2?.id).not.toBe(f1?.id);
    });

    it("targetFolder prefers the document, then the folder, then the root", async () => {
      const doc = await createDocument(A, "ann");
      const f = await folder(A, "F");
      const byDoc = await targetFolder(A, "ann", { documentId: doc.id, folderId: f.id });
      expect(byDoc.ok && byDoc.folderId).not.toBe(f.id);
      expect(await targetFolder(A, "ann", { folderId: f.id })).toEqual({ ok: true, folderId: f.id });
      expect(await targetFolder(A, "ann", {})).toEqual({ ok: true, folderId: null });
      expect(await targetFolder(B, "eve", { folderId: f.id })).toEqual({ ok: false, reason: "folder_not_found" });
      expect(await targetFolder(B, "eve", { documentId: doc.id })).toEqual({ ok: false, reason: "document_not_found" });
    });
  });

  describe("sources", () => {
    it("scopes every read and write to the team", async () => {
      const s = await createSource(A, "ann", { kind: "note", title: "Minutes", extracted_text: "text" });
      expect(await getSource(B, s.id)).toBeNull();
      expect(await listSources(B)).toEqual([]);
      expect(await listSources(B, { ids: [s.id] })).toEqual([]);
      expect(await updateSource(B, s.id, { title: "x" })).toEqual({ ok: false, reason: "not_found" });
      expect(await deleteSource(B, s.id)).toBeNull();
      expect(await listPassages(B, s.id)).toBeNull();
      expect(await replacePassages(B, s.id, [passage(0)])).toBe(false);
      await setSourceStatus(B, s.id, "error", "nope");
      await setSummary(B, s.id, "hijacked");
      await setExtraction(B, s.id, { status: "ready", text: "hijacked" });
      const mine = await getSource(A, s.id);
      expect(mine).toMatchObject({ extraction_status: "pending", summary: null, extracted_text: "text" });
    });

    it("rejects malformed ids without throwing", async () => {
      expect(await getSource(A, "not-a-uuid")).toBeNull();
      expect(await listSources(A, { folder: "nope" })).toEqual([]);
      expect(await listSources(A, { ids: ["nope"] })).toEqual([]);
    });

    it("lists without extracted text, filtered by folder, kind, ids and search", async () => {
      const f = await folder(A, "F");
      const note = await createSource(A, "ann", { kind: "note", title: "Board minutes", extracted_text: "The riverside budget was approved." });
      const link = await createSource(A, "ann", { kind: "url", url: "https://example.org/report", folder_id: f.id });
      const file = await createSource(A, "ann", { kind: "file", filename: "Budget 2026.pdf", mime: "application/pdf", folder_id: f.id });
      await setSummary(A, link.id, "A report on watershed funding.");

      const all = await listSources(A);
      expect(all.map((s) => s.id)).toEqual([file.id, link.id, note.id]); // newest first
      expect(all[0]).not.toHaveProperty("extracted_text");
      expect(all[0]).not.toHaveProperty("blob_url");
      expect(all[0]).not.toHaveProperty("team_id");

      expect((await listSources(A, { folder: "root" })).map((s) => s.id)).toEqual([note.id]);
      expect((await listSources(A, { folder: f.id })).map((s) => s.id)).toEqual([file.id, link.id]);
      expect((await listSources(A, { kind: "url" })).map((s) => s.id)).toEqual([link.id]);
      expect((await listSources(A, { ids: [note.id, file.id] })).map((s) => s.id)).toEqual([file.id, note.id]);
      expect((await listSources(A, { query: "RIVERSIDE" })).map((s) => s.id)).toEqual([note.id]); // extracted text
      expect((await listSources(A, { query: "budget" })).map((s) => s.id)).toEqual([file.id, note.id]); // filename + text
      expect((await listSources(A, { query: "watershed" })).map((s) => s.id)).toEqual([link.id]); // summary
      expect((await listSources(A, { query: "example.org" })).map((s) => s.id)).toEqual([link.id]); // url
    });

    it("moves and renames, refusing another team's folder", async () => {
      const f = await folder(A, "F");
      const theirs = await folder(B, "T");
      const s = await createSource(A, "ann", { kind: "note", title: "Old" });
      expect(await updateSource(A, s.id, { folder_id: theirs.id })).toEqual({ ok: false, reason: "folder_not_found" });
      const r = await updateSource(A, s.id, { title: "New", folder_id: f.id });
      expect(r).toMatchObject({ ok: true, source: { title: "New", folder_id: f.id } });
      const back = await updateSource(A, s.id, { folder_id: null });
      expect(back).toMatchObject({ ok: true, source: { title: "New", folder_id: null } });
    });

    it("fills a missing title only", async () => {
      const link = await createSource(A, "ann", { kind: "url", url: "https://example.org" });
      await setExtraction(A, link.id, { status: "summarizing", text: "body", title: "Page title" });
      expect((await getSource(A, link.id))?.title).toBe("Page title");
      await setTitleIfMissing(A, link.id, "Model title");
      expect((await getSource(A, link.id))?.title).toBe("Page title");
      const named = await createSource(A, "ann", { kind: "note", title: "Mine" });
      await setExtraction(A, named.id, { status: "ready", text: "body", title: "Other" });
      expect((await getSource(A, named.id))?.title).toBe("Mine");
    });
  });

  describe("links", () => {
    it("links, lists and unlinks within a team", async () => {
      const doc = await createDocument(A, "ann", { title: "Proposal" });
      const s1 = await createSource(A, "ann", { kind: "note", title: "one" });
      const s2 = await createSource(A, "ann", { kind: "note", title: "two" });
      expect(await linkSource(A, "ann", doc.id, s1.id, "background")).toBe("ok");
      expect(await linkSource(A, "ann", doc.id, s2.id)).toBe("ok");
      expect(await linkSource(A, "ann", doc.id, s1.id)).toBe("ok"); // idempotent, keeps the role

      const linked = await listDocumentSources(A, doc.id);
      expect(linked?.map((s) => [s.id, s.role])).toEqual([
        [s1.id, "background"],
        [s2.id, null],
      ]);
      expect((await getSource(A, s1.id))?.document_ids).toEqual([doc.id]);
      expect((await listSources(A, { documentId: doc.id })).map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());

      expect(await unlinkSource(A, doc.id, s1.id)).toBe(true);
      expect(await unlinkSource(A, doc.id, s1.id)).toBe(false);
      expect((await listDocumentSources(A, doc.id))?.map((s) => s.id)).toEqual([s2.id]);
    });

    it("requires both the document and the source to be the caller's team's", async () => {
      const myDoc = await createDocument(A, "ann");
      const theirDoc = await createDocument(B, "eve");
      const mine = await createSource(A, "ann", { kind: "note", title: "mine" });
      const theirs = await createSource(B, "eve", { kind: "note", title: "theirs" });
      expect(await linkSource(A, "ann", myDoc.id, theirs.id)).toBe("source_not_found");
      expect(await linkSource(A, "ann", theirDoc.id, mine.id)).toBe("document_not_found");
      expect(await linkSource(B, "eve", myDoc.id, theirs.id)).toBe("document_not_found");
      expect(await listDocumentSources(B, myDoc.id)).toBeNull();

      await linkSource(A, "ann", myDoc.id, mine.id);
      expect(await unlinkSource(B, myDoc.id, mine.id)).toBe(false);
      expect((await listDocumentSources(A, myDoc.id))?.map((s) => s.id)).toEqual([mine.id]);
    });

    it("hides a deleted document's links", async () => {
      const doc = await createDocument(A, "ann");
      const s = await createSource(A, "ann", { kind: "note", title: "n" });
      await linkSource(A, "ann", doc.id, s.id);
      await deleteDocument(A, doc.id);
      expect(await listDocumentSources(A, doc.id)).toBeNull();
      expect(await getSource(A, s.id)).not.toBeNull(); // the source stays in the library
    });
  });

  describe("passages and deletes", () => {
    it("replaces passages", async () => {
      const s = await createSource(A, "ann", { kind: "note", title: "n" });
      expect(await listPassages(A, s.id)).toEqual([]);
      await replacePassages(A, s.id, [passage(0), passage(1)]);
      expect((await listPassages(A, s.id))?.map((p) => p.idx)).toEqual([0, 1]);
      await replacePassages(A, s.id, [passage(0)]);
      expect(await listPassages(A, s.id)).toEqual([passage(0)]);
    });

    it("deleting a source removes its links and passages", async () => {
      const doc = await createDocument(A, "ann");
      const s = await createSource(A, "ann", { kind: "file", filename: "a.pdf" });
      await linkSource(A, "ann", doc.id, s.id);
      await replacePassages(A, s.id, [passage(0)]);
      const deleted = await deleteSource(A, s.id);
      expect(deleted?.id).toBe(s.id);
      expect(await getSource(A, s.id)).toBeNull();
      expect(await listPassages(A, s.id)).toBeNull();
      expect(await listDocumentSources(A, doc.id)).toEqual([]);
      expect(await deleteSource(A, s.id)).toBeNull();
    });
  });

  describe("stale statuses", () => {
    const at = (status: Parameters<typeof reportedStatus>[0]["extraction_status"], ageMs: number) =>
      reportedStatus({ extraction_status: status, extraction_error: null, updated_at: new Date(1_000_000_000_000 - ageMs).toISOString() }, 1_000_000_000_000);

    it("reports a busy status left by a stopped run as a retryable error", () => {
      for (const status of ["pending", "extracting", "summarizing"] as const) {
        expect(at(status, 60_000)).toEqual({ status, error: null });
        expect(at(status, STALE_BUSY_MS + 1)).toMatchObject({ status: "error", error: expect.stringMatching(/Read it again/) });
      }
    });

    it("gives an upload longer, then reports it as unfinished", () => {
      expect(at("uploading", STALE_BUSY_MS + 1)).toEqual({ status: "uploading", error: null });
      expect(at("uploading", STALE_UPLOAD_MS + 1)).toMatchObject({ status: "error", error: expect.stringMatching(/upload didn't finish/) });
    });

    it("never changes a finished status", () => {
      for (const status of ["ready", "partial", "error"] as const) expect(at(status, STALE_UPLOAD_MS * 10).status).toBe(status);
    });

    it("applies to what the API returns", async () => {
      const s = await createSource(A, "ann", { kind: "note", title: "n", extracted_text: "t" });
      await setSourceStatus(A, s.id, "extracting");
      const row = (await getSource(A, s.id))!;
      expect(toSummary(row).extraction_status).toBe("extracting");
      const old = { ...row, updated_at: new Date(Date.now() - STALE_BUSY_MS - 1000).toISOString() };
      expect(toSummary(old)).toMatchObject({ extraction_status: "error" });
    });
  });
});
