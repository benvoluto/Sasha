import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recentRunSummaries: vi.fn() }));
vi.mock("@/lib/workflow/store", () => ({ recentRunSummaries: mocks.recentRunSummaries }));

import { createDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { activityFeed } from "./feed";

const TEAM = "org:a";

/** A run summary with only the fields the feed reads. */
const run = (id: string, documentId: string, at: string, status = "complete") => ({
  id,
  document_id: documentId,
  status,
  workflow_name: "Check against the rubric",
  requested_by: "bo@example.com",
  updated_at: at,
});

describe("activityFeed", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    mocks.recentRunSummaries.mockReset().mockResolvedValue([]);
  });

  it("lists documents created and edited, newest first, with the right actor", async () => {
    const a = await createDocument(TEAM, "ann@example.com", { title: "Plan" });
    const b = await createDocument(TEAM, "ann@example.com", { title: "Brief" });
    await updateDocument(TEAM, a.id, "cy@example.com", { title: "Plan v2" });

    const items = await activityFeed(TEAM, { limit: 10, includeRuns: false });
    expect(items.map((i) => [i.kind, i.document_id, i.kind === "document" ? i.action : "", i.actor, i.document_title])).toEqual([
      ["document", a.id, "edited", "cy@example.com", "Plan v2"],
      ["document", b.id, "created", "ann@example.com", "Brief"],
    ]);
    expect(items[0].href).toBe(`/d/${a.id}`);
    expect(mocks.recentRunSummaries).not.toHaveBeenCalled();
  });

  it("merges runs by time, links them to the run and joins the document title", async () => {
    const doc = await createDocument(TEAM, "ann@example.com", { title: "Plan" });
    mocks.recentRunSummaries.mockResolvedValue([run("r1", doc.id, "2999-01-01T00:00:00.000Z", "awaiting_review"), run("r0", doc.id, "2000-01-01T00:00:00.000Z")]);

    const items = await activityFeed(TEAM, { limit: 10, includeRuns: true });
    expect(items.map((i) => i.id)).toEqual(["run:r1", `doc:${doc.id}`, "run:r0"]);
    expect(items[0]).toMatchObject({ kind: "run", run_id: "r1", document_title: "Plan", status: "awaiting_review", actor: "bo@example.com", href: `/d/${doc.id}?run=r1` });
    expect(mocks.recentRunSummaries).toHaveBeenCalledWith(TEAM, 10);
  });

  it("looks up a run's document outside the recent list, and skips runs whose document is gone", async () => {
    const old = await createDocument(TEAM, "ann@example.com", { title: "Old" });
    await updateDocument(TEAM, old.id, "ann@example.com", { archived: true });
    mocks.recentRunSummaries.mockResolvedValue([
      run("r1", old.id, "2999-01-01T00:00:00.000Z"),
      run("r2", "00000000-0000-4000-8000-000000000000", "2999-01-02T00:00:00.000Z"),
    ]);

    const items = await activityFeed(TEAM, { limit: 10, includeRuns: true });
    expect(items.map((i) => [i.id, i.document_title])).toEqual([["run:r1", "Old"]]);
  });

  it("cuts the merged list to the limit and stays inside the team", async () => {
    for (let i = 0; i < 3; i++) await createDocument(TEAM, "ann@example.com", { title: `D${i}` });
    await createDocument("org:other", "zed@example.com", { title: "Theirs" });
    const items = await activityFeed(TEAM, { limit: 2, includeRuns: false });
    expect(items.map((i) => i.document_title)).toEqual(["D2", "D1"]);
  });
});
