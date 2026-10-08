import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeJson: vi.fn(), getType: vi.fn(), configured: { value: true } }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeJson: mocks.claudeJson,
  claudeConfigured: () => mocks.configured.value,
}));
vi.mock("@/catalog", () => ({ getType: mocks.getType }));

import { fileTypeByKey, fileTypes } from "@/catalog/files";
import { outlineDoc } from "@/catalog/outline";
import { listSections } from "@/lib/documents/sections";
import { createDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { contentHash, MIN_MODEL_INTERVAL_MS, modelInput, outlineStatus, presence, resetOutlineStatusCache } from "./outline-status";
import { docOf, heading, para, testType } from "./test-fixtures";

const T = "org:a";
const def = testType();
const entry = { definition: def, origin: "file", enabled: true, overridden: false, updated_at: null };

const body = () =>
  docOf(
    heading("Summary", "s_sum", "summary"),
    para("We request $40k to restore the river bank."),
    heading("Budget", "s_bud", "budget"),
    para(""),
    heading("Risks", "s_risk", null),
    para("Floods."),
    heading("Old thing", "s_old", "not-in-type"),
    heading("Detail", "s_det", null, 3),
  );

const modelReply = { data: { sections: [{ specKey: "summary", elements: [{ element: "amount requested", status: "done" }] }] }, usage: {} };

describe("outlineStatus", () => {
  let clock = 1_000_000;
  const now = () => clock;

  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetOutlineStatusCache();
    clock = 1_000_000;
    mocks.claudeJson.mockReset().mockResolvedValue(modelReply);
    mocks.getType.mockReset().mockResolvedValue(entry);
    mocks.configured.value = true;
  });

  it("reports presence, extra sections, and missing elements of empty sections without the model", async () => {
    const d = await createDocument(T, "ann", { type_key: def.key, content_json: body() });
    const r = (await outlineStatus(T, d.id, { now }))!;
    expect(r).toMatchObject({ typeKey: "test-proposal", typeVersion: 3, model: true });
    expect(r.contentHash).toBe(contentHash(d.content_text, def.key, 3));
    expect(r.sections.map((s) => [s.specKey, s.present, s.hasContent, s.sectionId])).toEqual([
      ["memo-header", false, false, null],
      ["summary", true, true, "s_sum"],
      ["budget", true, false, "s_bud"],
      ["timeline", false, false, null],
    ]);
    // The model only saw the section with text; the element it matched loosely is done, the one it skipped is missing.
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    const call = mocks.claudeJson.mock.calls[0][0];
    expect(call.task).toBe("outline.status");
    expect(call.user).toContain('<section key="summary"');
    expect(call.user).not.toContain('key="budget"');
    expect(r.sections[1].elements).toEqual([
      { element: "Amount requested", status: "done" },
      { element: "Purpose", status: "missing" },
    ]);
    expect(r.sections[2].elements.every((e) => e.status === "missing")).toBe(true);
    expect(r.sections[3].required).toBe(false);
    expect(r.extraSections).toEqual([
      { sectionId: "s_risk", heading: "Risks", level: 2 },
      { sectionId: "s_old", heading: "Old thing", level: 2 },
    ]);
  });

  it("returns the cached result for the same content and rate-limits model runs", async () => {
    const d = await createDocument(T, "ann", { type_key: def.key, content_json: body() });
    const first = await outlineStatus(T, d.id, { now });
    clock += 1000;
    expect(await outlineStatus(T, d.id, { now })).toBe(first);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);

    // Changed content inside the 20 s window: the last result, with its stale hash.
    const changed = await updateDocument(T, d.id, "ann", { content_json: docOf(heading("Summary", "s_sum", "summary"), para("New text.")) });
    expect(changed.ok).toBe(true);
    const stale = await outlineStatus(T, d.id, { now, force: true });
    expect(stale).toBe(first);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);

    clock += MIN_MODEL_INTERVAL_MS;
    const fresh = await outlineStatus(T, d.id, { now });
    expect(fresh?.contentHash).not.toBe(first?.contentHash);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(2);

    // force recomputes the same content once the window has passed.
    clock += MIN_MODEL_INTERVAL_MS;
    await outlineStatus(T, d.id, { now, force: true });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(3);
  });

  it("shares one model run between concurrent requests, forced or not", async () => {
    const d = await createDocument(T, "ann", { type_key: def.key, content_json: body() });
    let release!: (v: typeof modelReply) => void;
    mocks.claudeJson.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const calls = Array.from({ length: 20 }, (_, i) => outlineStatus(T, d.id, { now, force: i % 2 === 0 }));
    await vi.waitFor(() => expect(mocks.claudeJson).toHaveBeenCalledTimes(1));
    release(modelReply);
    const results = await Promise.all(calls);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]?.model).toBe(true);

    // Once it has finished, the 20 s window still applies to a forced request.
    clock += 1000;
    expect(await outlineStatus(T, d.id, { now, force: true })).toBe(results[0]);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("marks elements unknown without Claude or when the call fails", async () => {
    const d = await createDocument(T, "ann", { type_key: def.key, content_json: body() });
    mocks.configured.value = false;
    const off = (await outlineStatus(T, d.id, { now }))!;
    expect(off.model).toBe(false);
    expect(off.sections[1].elements.map((e) => e.status)).toEqual(["unknown", "unknown"]);
    expect(off.sections[2].elements.map((e) => e.status)).toEqual(["missing", "missing"]);
    expect(mocks.claudeJson).not.toHaveBeenCalled();

    mocks.configured.value = true;
    mocks.claudeJson.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = (await outlineStatus(T, d.id, { now }))!;
    expect(failed.model).toBe(false);
    expect(failed.sections[1].elements.map((e) => e.status)).toEqual(["unknown", "unknown"]);

    // A failure isn't served as a cache hit once the window has passed.
    mocks.claudeJson.mockResolvedValue(modelReply);
    clock += MIN_MODEL_INTERVAL_MS;
    expect((await outlineStatus(T, d.id, { now }))?.model).toBe(true);
  });

  it("lists headings for a document with no type, and null for another team", async () => {
    mocks.getType.mockResolvedValue(null);
    const d = await createDocument(T, "ann", { content_json: body() });
    const r = (await outlineStatus(T, d.id, { now }))!;
    expect(r).toMatchObject({ typeKey: null, typeVersion: null, sections: [], model: false });
    expect(r.extraSections.map((s) => s.sectionId)).toEqual(["s_sum", "s_bud", "s_risk", "s_old"]);
    expect(await outlineStatus("org:b", d.id, { now })).toBeNull();
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });
});

describe("outline status of a new document of each bundled type", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetOutlineStatusCache();
    mocks.claudeJson.mockReset().mockResolvedValue({ data: { sections: [] }, usage: {} });
    mocks.configured.value = true;
  });

  it.each(fileTypes().map((t) => [t.key, t] as const))("%s: every section is empty and the model isn't asked", async (_key, type) => {
    mocks.getType.mockResolvedValue({ definition: type, origin: "file", enabled: true, overridden: false, updated_at: null });
    // Exactly what POST /api/documents seeds: headings, scaffolds, empty paragraphs.
    const d = await createDocument(T, "ann", { type_key: type.key, content_json: outlineDoc(type.sections) });
    const r = (await outlineStatus(T, d.id))!;
    for (const row of r.sections) {
      expect([row.specKey, row.present, row.hasContent]).toEqual([row.specKey, true, false]);
      expect(row.elements.every((e) => e.status === "missing")).toBe(true);
    }
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });
});

describe("own section bodies (a parent stops at its typed sub-sections)", () => {
  const nih = fileTypeByKey("nih-specific-aims-research-strategy")!;
  const ids = () => {
    let n = 0;
    return () => `s_${String(++n).padStart(8, "0")}`;
  };

  it("doesn't count a parent's sub-section headings or their text as its content", () => {
    const blank = listSections(outlineDoc(nih.sections, ids()), { own: true });
    const row = (rows: ReturnType<typeof presence>["sections"], key: string) => rows.find((x) => x.specKey === key)!;
    expect(row(presence(nih, blank).sections, "research-strategy")).toMatchObject({ present: true, hasContent: false });

    // Significance written; Research Strategy has no prose of its own.
    const doc = outlineDoc(nih.sections, ids());
    const sig = doc.content!.findIndex((n) => n.attrs?.specKey === "significance");
    doc.content!.splice(sig + 1, 1, para("Kidney disease affects one in seven adults."));
    const det = presence(nih, listSections(doc, { own: true })).sections;
    expect(row(det, "research-strategy").hasContent).toBe(false);
    expect(row(det, "significance").hasContent).toBe(true);
  });

  it("sends a parent's own text, naming its sub-sections, not their text", () => {
    const doc = outlineDoc(nih.sections, ids());
    const rs = doc.content!.findIndex((n) => n.attrs?.specKey === "research-strategy");
    doc.content!.splice(rs + 1, 0, para("The strategy follows the three aims."));
    const sig = doc.content!.findIndex((n) => n.attrs?.specKey === "significance");
    doc.content!.splice(sig + 1, 1, para("Kidney disease affects one in seven adults."));
    const sections = listSections(doc, { own: true });
    const rows = presence(nih, sections).sections.filter((x) => x.specKey === "research-strategy");
    expect(rows[0].hasContent).toBe(true);
    const user = modelInput(rows, sections);
    expect(user).toContain("The strategy follows the three aims.");
    expect(user).not.toContain("Kidney disease");
    expect(user).toContain("Significance; Innovation; Approach; Progress Report");
  });
});
