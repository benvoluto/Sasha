import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ team: { value: "org:a" }, configured: { value: true }, claudeJson: vi.fn() }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: mocks.team.value, agent: "ann" }) }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeConfigured: () => mocks.configured.value,
  claudeJson: mocks.claudeJson,
}));

import { createDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import type { PMNode } from "@/lib/documents/sections";
import { ModelDeadlineError, ModelRefusalError } from "@/lib/llm/claude";
import { MAX_CHECK_CHARS, textFingerprint, type RubricCheckResponse } from "@/lib/rubric/contract";
import { heading, para } from "@/lib/sections/test-fixtures";
import { passagePrefix } from "@/lib/sources/pages";
import { createSource } from "@/lib/sources/store";
import { GET, POST } from "./route";

const USAGE = { model: "claude-sonnet-5-5", input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const content: PMNode[] = [heading("Summary", "sum", "summary"), para("We request £40,000 to rebuild the path."), heading("Budget", "bud", "budget"), para("Bank works £38,400.")];

const post = (id: string, body: unknown) => POST(new Request(`http://x/api/documents/${id}/check`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const get = (id: string, sectionId?: string) => GET(new Request(`http://x/api/documents/${id}/check${sectionId ? `?sectionId=${sectionId}` : ""}`), { params: Promise.resolve({ id }) });

function reply() {
  mocks.claudeJson.mockImplementation(async () => ({
    data: { scores: [{ criterion: "clarity", level: 2, rationale: "Vague.", evidence: [{ id: "sum", quote: "We request £40,000" }, { id: "bud", quote: "invented" }], fix: "Say what the money buys.", fix_section: "sum" }] },
    usage: USAGE,
  }));
}

async function makeDoc(body: PMNode[] = content, typeKey: string | null = "proposal") {
  return createDocument("org:a", "ann", { title: "Path", type_key: typeKey, content_json: { type: "doc", content: body } });
}

describe("POST/GET /api/documents/[id]/check", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    mocks.team.value = "org:a";
    mocks.configured.value = true;
    mocks.claudeJson.mockReset();
    reply();
  });

  it("checks the document, then returns the cached result for the same inputs; GET reads it", async () => {
    const doc = await makeDoc();
    const res = await post(doc.id, { scope: "document" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as RubricCheckResponse;
    expect(out).toMatchObject({ scope: "document", sectionId: null, typeKey: "proposal", cached: false, droppedEvidence: 1 });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ criterion: "clarity", origin: "universal", level: 2, fixSectionId: "sum", fixSectionHeading: "Summary", evidence: [{ quote: "We request £40,000", sectionId: "sum", heading: "Summary" }] });
    expect(out.sectionFingerprints).toEqual({ sum: textFingerprint("We request £40,000 to rebuild the path."), bud: textFingerprint("Bank works £38,400.") });
    expect(mocks.claudeJson.mock.calls[0][0].task).toBe("rubric.check");

    const again = (await (await post(doc.id, { scope: "document" })).json()) as RubricCheckResponse;
    expect(again).toMatchObject({ cached: true, inputsHash: out.inputsHash });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);

    const stored = await get(doc.id);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ cached: true, inputsHash: out.inputsHash });
    expect((await get(doc.id, "sum")).status).toBe(404);
  });

  it("tells the model which claims cite a source, and a new citation changes the inputs", async () => {
    const src = await createSource("org:a", "ann", { kind: "note", title: "Contractor quote", extracted_text: "Bank works cost £38,400.", extraction_status: "ready" });
    const passageId = `${passagePrefix(src.id)}.P0`;
    const cited = (marked: boolean): PMNode[] => [
      heading("Summary", "sum", "summary"),
      para("We request £40,000 to rebuild the path."),
      heading("Budget", "bud", "budget"),
      { type: "paragraph", content: [{ type: "text", text: "Bank works £38,400.", ...(marked ? { marks: [{ type: "citation", attrs: { kind: "passage", passageId, sourceId: src.id, dataTableId: null, quote: null, verified: true } }] } : {}) }] },
    ];
    const doc = await makeDoc(cited(false));
    const plain = (await (await post(doc.id, { scope: "section", sectionId: "bud" })).json()) as RubricCheckResponse;
    expect(mocks.claudeJson.mock.calls[0][0].user).not.toContain("<citations>");

    await updateDocument("org:a", doc.id, "ann", { content_json: { type: "doc", content: cited(true) } });
    const out = (await (await post(doc.id, { scope: "section", sectionId: "bud" })).json()) as RubricCheckResponse;
    expect(out.cached).toBe(false);
    expect(out.inputsHash).not.toBe(plain.inputsHash);
    const user = mocks.claudeJson.mock.calls[1][0].user as string;
    expect(user).toContain("[bud] “Bank works £38,400.” cites [1] Contractor quote");
    expect(user).toContain("never ask for a citation it already has");
  });

  it("429s a forced re-check of the same inputs within the interval, with retryAfterSeconds", async () => {
    const doc = await makeDoc();
    await post(doc.id, { scope: "document" });
    const res = await post(doc.id, { scope: "document", force: true });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error).toMatch(/^Checked moments ago\. Try again in \d+s\.$/);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(1);
  });

  it("an edit past the prompt's per-section clip still changes the inputs (no stale cache, no interval 429)", async () => {
    const long = "word ".repeat(5000).trim(); // 24,999 characters, past the 20k clip
    const doc = await makeDoc([heading("Summary", "sum", "summary"), para(long)]);
    const first = (await (await post(doc.id, { scope: "section", sectionId: "sum" })).json()) as RubricCheckResponse;
    await updateDocument("org:a", doc.id, "ann", { content_json: { type: "doc", content: [heading("Summary", "sum", "summary"), para(`${long} more`)] } });
    const res = await post(doc.id, { scope: "section", sectionId: "sum", force: true });
    expect(res.status).toBe(200);
    const second = (await res.json()) as RubricCheckResponse;
    expect(second.cached).toBe(false);
    expect(second.inputsHash).not.toBe(first.inputsHash);
    expect(mocks.claudeJson).toHaveBeenCalledTimes(2);
  });

  it("a section check sends that section, applies its criteria and fingerprints only it", async () => {
    const doc = await makeDoc();
    const res = await post(doc.id, { scope: "section", sectionId: "bud" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as RubricCheckResponse;
    expect(out).toMatchObject({ scope: "section", sectionId: "bud" });
    expect(Object.keys(out.sectionFingerprints)).toEqual(["bud"]);
    const user = mocks.claudeJson.mock.calls[0][0].user as string;
    expect(user).toContain("Bank works");
    expect(user).not.toContain("We request");
    // "sum" was not shown: neither the fix section nor the quote from it is kept.
    expect(out.results[0]).toMatchObject({ fixSectionId: null, evidence: [] });
    expect((await get(doc.id, "bud")).status).toBe(200);
    expect((await post(doc.id, { scope: "section", sectionId: "gone" })).status).toBe(404);
  });

  it("413s a document over the limit, 400s empty text and bad bodies", async () => {
    const big = await makeDoc([heading("A", "a"), para("x".repeat(MAX_CHECK_CHARS + 10))], null);
    const res = await post(big.id, { scope: "document" });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/Check one section at a time/);
    const empty = await makeDoc([heading("A", "a"), para("")], null);
    expect((await post(empty.id, { scope: "document" })).status).toBe(400);
    expect((await post(empty.id, { scope: "section", sectionId: "a" })).status).toBe(400);
    expect((await post(empty.id, { scope: "nope" })).status).toBe(400);
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });

  it("scopes by team: another team's document is not found", async () => {
    const doc = await makeDoc();
    await post(doc.id, { scope: "document" });
    mocks.team.value = "org:b";
    expect((await post(doc.id, { scope: "document" })).status).toBe(404);
    expect((await get(doc.id)).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });

  it("503s without Claude (a cached result is still served)", async () => {
    const doc = await makeDoc();
    mocks.configured.value = false;
    const res = await post(doc.id, { scope: "document" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Claude is not configured." });
    mocks.configured.value = true;
    await post(doc.id, { scope: "document" });
    mocks.configured.value = false;
    expect((await post(doc.id, { scope: "document" })).status).toBe(200);
  });

  it("maps model errors like the generate route", async () => {
    const doc = await makeDoc();
    mocks.claudeJson.mockRejectedValueOnce(new ModelRefusalError(null));
    expect((await post(doc.id, { scope: "section", sectionId: "sum" })).status).toBe(422);
    mocks.claudeJson.mockRejectedValueOnce(new ModelDeadlineError());
    expect((await post(doc.id, { scope: "section", sectionId: "bud" })).status).toBe(504);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.claudeJson.mockRejectedValueOnce(new Error("network"));
    const res = await post(doc.id, { scope: "document" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The check failed. Try again." });
  });
});
