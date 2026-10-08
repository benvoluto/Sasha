import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write: async () => {} }) }));

import { createDocFolder, getDocFolder } from "@/lib/documents/folder-store";
import { MAX_DOCUMENT_NOTES } from "@/lib/documents/notes-contract";
import { createDocument, getDocument, resetMemoryStore } from "@/lib/documents/store";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { createRun, getRun, listDocumentRuns, recentRunSummaries, saveRun } from "@/lib/workflow/store";
import { DELETE, PATCH } from "./route";

const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("PATCH /api/documents/[id] doc_folder_id", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("moves a document into a folder and back without bumping updated_at", async () => {
    const d = await createDocument("org:a", "ann");
    const f = await createDocFolder("org:a", "ann", "Grants");
    if (!f.ok) throw new Error("folder");
    const res = await patch(d.id, { doc_folder_id: f.folder.id });
    expect(res.status).toBe(200);
    expect((await res.json()).document).toMatchObject({ doc_folder_id: f.folder.id, updated_at: d.updated_at });
    expect((await getDocFolder("org:a", f.folder.id))?.document_count).toBe(1);

    // The editor's next save with its old base still goes through.
    const saved = await patch(d.id, { title: "Kept", base_updated_at: d.updated_at });
    expect(saved.status).toBe(200);

    expect((await (await patch(d.id, { doc_folder_id: null })).json()).document.doc_folder_id).toBeNull();
  });

  it("400s an unknown or another team's folder and leaves the document alone", async () => {
    const d = await createDocument("org:a", "ann");
    const theirs = await createDocFolder("org:b", "zed", "Theirs");
    if (!theirs.ok) throw new Error("folder");
    const res = await patch(d.id, { doc_folder_id: theirs.folder.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown folder." });
    const ghost = await patch(d.id, { doc_folder_id: "00000000-0000-4000-8000-000000000000" });
    expect(ghost.status).toBe(400);
    expect((await patch(d.id, { doc_folder_id: "nope" })).status).toBe(400);
    expect((await getDocument("org:a", d.id))?.doc_folder_id).toBeNull();
  });
});


describe("PATCH /api/documents/[id] notes and type_source", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("saves notes up to the cap and 400s anything longer, leaving the notes alone", async () => {
    const d = await createDocument("org:a", "ann");
    const full = "n".repeat(MAX_DOCUMENT_NOTES);
    const ok = await patch(d.id, { notes: full, base_updated_at: d.updated_at });
    expect(ok.status).toBe(200);
    const after = (await ok.json()).document;
    expect(after.notes).toHaveLength(MAX_DOCUMENT_NOTES);

    const over = await patch(d.id, { notes: full + "x", base_updated_at: after.updated_at });
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "Invalid changes." });
    expect((await getDocument("org:a", d.id))?.notes).toHaveLength(MAX_DOCUMENT_NOTES);
  });

  it("takes type_source only from its enum, defaulting to user", async () => {
    const d = await createDocument("org:a", "ann");
    const chip = await patch(d.id, { type_key: "proposal", type_source: "classifier" });
    expect(chip.status).toBe(200);
    expect((await chip.json()).document).toMatchObject({ type_key: "proposal", type_source: "classifier" });

    for (const type_source of ["RESTRUCTURE", "CLASSIFIER", "", 1, null]) {
      expect((await patch(d.id, { type_key: "sop", type_source })).status).toBe(400);
    }
    expect((await getDocument("org:a", d.id))?.type_source).toBe("classifier");

    // A workflow's restructure sets the type it mapped the document onto.
    const restructured = await patch(d.id, { type_key: "sop", type_source: "restructure" });
    expect((await restructured.json()).document).toMatchObject({ type_key: "sop", type_source: "restructure" });

    const byHand = await patch(d.id, { type_key: "sop" });
    expect((await byHand.json()).document).toMatchObject({ type_key: "sop", type_source: "user" });
  });

  it("counts a notes save as an edit: a save based on the version before it is a 409", async () => {
    const d = await createDocument("org:a", "ann");
    const notes = await patch(d.id, { notes: "For the board.", base_updated_at: d.updated_at });
    expect(notes.status).toBe(200);
    const after = (await notes.json()).document;
    expect(after.updated_at > d.updated_at).toBe(true);

    // A teammate's tab still holding the old version.
    const stale = await patch(d.id, { title: "Theirs", base_updated_at: d.updated_at });
    expect(stale.status).toBe(409);
    const out = await stale.json();
    expect(out.document).toMatchObject({ notes: "For the board.", updated_at: after.updated_at });
    expect((await getDocument("org:a", d.id))?.title).not.toBe("Theirs");

    // Keep mine (force) goes through.
    expect((await patch(d.id, { title: "Theirs", base_updated_at: d.updated_at, force: true })).status).toBe(200);
  });

  it("404s another team's document", async () => {
    const theirs = await createDocument("org:b", "zed");
    expect((await patch(theirs.id, { notes: "x" })).status).toBe(404);
    expect((await getDocument("org:b", theirs.id))?.notes).toBe("");
  });
});

describe("PATCH /api/documents/[id] invalid JSON", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("400s a body that isn't JSON and writes nothing", async () => {
    const d = await createDocument("org:a", "ann");
    for (const body of ["{not json", "", "undefined"]) {
      const res = await PATCH(new Request(`http://x/api/documents/${d.id}`, { method: "PATCH", body }), { params: Promise.resolve({ id: d.id }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid changes." });
    }
    expect((await getDocument("org:a", d.id))?.updated_at).toBe(d.updated_at);
  });
});

describe("DELETE /api/documents/[id]", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  const workflow = { workflow_id: "wf-1", name: "W", version: 1, graph: defaultWorkflowGraph(), note: "", created_by: "x", created_at: "", readOnly: false, based_on: null };
  const auth = { agent: "ann", permissions: [] };

  it("deletes the document's runs with it, leaving other documents' and teams' runs alone", async () => {
    const d = await createDocument("org:a", "ann");
    const other = await createDocument("org:a", "ann");
    const theirs = await createDocument("org:b", "zed");
    const run = await createRun("org:a", d.id, workflow, {}, auth);
    const kept = await createRun("org:a", other.id, workflow, {}, auth);
    const theirRun = await createRun("org:b", theirs.id, workflow, {}, auth);

    const res = await DELETE(new Request(`http://x/api/documents/${d.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: d.id }) });
    expect(res.status).toBe(200);
    expect(await getRun("org:a", run.id)).toBeNull();
    expect(await listDocumentRuns("org:a", d.id)).toEqual([]);
    expect((await recentRunSummaries("org:a", 10)).map((r) => r.id)).toEqual([kept.id]);
    expect(await getRun("org:b", theirRun.id)).not.toBeNull();

    // A run still executing when the document went does not come back when it saves.
    run.status = "complete";
    await saveRun(run);
    expect(await getRun("org:a", run.id)).toBeNull();
  });

  it("404s another team's document and keeps its runs", async () => {
    const theirs = await createDocument("org:b", "zed");
    const run = await createRun("org:b", theirs.id, workflow, {}, auth);
    const res = await DELETE(new Request(`http://x/api/documents/${theirs.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: theirs.id }) });
    expect(res.status).toBe(404);
    expect(await getRun("org:b", run.id)).not.toBeNull();
  });
});
