import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeText: vi.fn(), getType: vi.fn(), configured: { value: true } }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeText: mocks.claudeText,
  claudeConfigured: () => mocks.configured.value,
}));
vi.mock("@/catalog", () => ({ getType: mocks.getType }));

import { getSectionMeta, putSectionNotes } from "@/lib/documents/section-store";
import { createDocument, getDocument, resetMemoryStore } from "@/lib/documents/store";
import { listSections } from "@/lib/documents/sections";
import { dropRepeatedHeading, findTarget, generateSection, MODE_TASKS, neighboursOf, type ParsedGenerateRequest } from "./generate";
import { docOf, heading, para, testType } from "./test-fixtures";

const T = "org:a";
const def = testType();
const reply = (text: string) => ({ text, usage: {} });

async function makeDoc() {
  return createDocument(T, "ann", {
    title: "River Plan",
    type_key: def.key,
    content_json: docOf(heading("Header", "s_head", "memo-header"), para("To: council"), heading("Summary", "s_sum", "summary"), para("We ask for funds."), heading("Budget", "s_bud", "budget"), para(""), heading("Timeline", "s_tim", "timeline"), para("Spring start.")),
  });
}

const req = (r: Partial<ParsedGenerateRequest> & Pick<ParsedGenerateRequest, "mode">): ParsedGenerateRequest => ({ heading: "Budget", level: 2, specKey: "budget", body: "", ...r });

describe("generateSection", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    mocks.claudeText.mockReset().mockResolvedValue(reply("```markdown\n## Budget\n\n| Item | Cost |\n|---|---|\n| Staff | $10k |\n```"));
    mocks.getType.mockReset().mockResolvedValue({ definition: def, origin: "file", enabled: true, overridden: false, updated_at: null });
    mocks.configured.value = true;
  });

  it("picks the task for each mode", async () => {
    expect(MODE_TASKS).toEqual({ draft: "draft.section", rewrite: "rewrite.section", draft_from_notes: "draft.from_notes", rewrite_from_notes: "draft.from_notes" });
    const d = await makeDoc();
    await putSectionNotes(T, d.id, "s_bud", { notes: "Staff $10k" });
    const cases: Array<[ParsedGenerateRequest, string]> = [
      [req({ mode: "draft" }), "draft.section"],
      [req({ mode: "rewrite", body: "Old", preset: "concise" }), "rewrite.section"],
      [req({ mode: "draft_from_notes" }), "draft.from_notes"],
      [req({ mode: "rewrite_from_notes", body: "Old" }), "draft.from_notes"],
    ];
    for (const [r, task] of cases) {
      mocks.claudeText.mockClear();
      const res = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: r });
      expect(res.ok && res.response.task).toBe(task);
      expect(mocks.claudeText.mock.calls[0][0]).toMatchObject({ task, agent: "ann", documentId: d.id });
    }
  });

  it("returns the body without fences or a repeated heading, marks the section drafted and leaves the document alone", async () => {
    const d = await makeDoc();
    const res = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft" }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.markdown).toBe("| Item | Cost |\n|---|---|\n| Staff | $10k |");
    expect(res.response.sourcesUsed).toBe(0);
    expect(res.response.section).toMatchObject({ section_id: "s_bud", status: "drafted", spec_key: "budget" });
    expect(await getSectionMeta(T, d.id, "s_bud")).toMatchObject({ status: "drafted" });
    expect((await getDocument(T, d.id))?.updated_at).toBe(d.updated_at);

    const { system, user } = mocks.claudeText.mock.calls[0][0];
    expect(system).toContain(def.preamble);
    expect(user).toContain("Lay out the budget by line item.");
    expect(user).toMatch(/>> +Budget/);
    expect(user).toContain('<previous_section heading="Summary">\nWe ask for funds.');
    expect(user).toContain('<next_section heading="Timeline">\nSpring start.');
    expect(user).toContain("No sources are linked");
  });

  it("refuses to draft a static section but allows rewriting it", async () => {
    const d = await makeDoc();
    const draft = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_head", req: req({ mode: "draft", heading: "Header", specKey: "memo-header" }) });
    expect(draft).toMatchObject({ ok: false, code: "static", status: 409, error: "This section is fixed text; edit it directly." });
    expect(mocks.claudeText).not.toHaveBeenCalled();
    const rewrite = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_head", req: req({ mode: "rewrite", heading: "Header", specKey: "memo-header", body: "To: council", instruction: "Fill in the date" }) });
    expect(rewrite.ok).toBe(true);
    // A fixed section's reply keeps one field per line when the editor converts it; a narrative one doesn't ask for that.
    expect(rewrite.ok && rewrite.response.lineBreaks).toBe(true);
    const narrative = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft" }) });
    expect(narrative.ok && narrative.response.lineBreaks).toBeUndefined();
  });

  it("needs notes in the notes modes, preferring the request's over the stored ones", async () => {
    const d = await makeDoc();
    const none = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft_from_notes" }) });
    expect(none).toMatchObject({ ok: false, code: "notes_required", status: 400 });
    await putSectionNotes(T, d.id, "s_bud", { notes: "stored notes" });
    await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft_from_notes", notes: "fresh notes" }) });
    const user = mocks.claudeText.mock.calls[0][0].user as string;
    expect(user).toContain("fresh notes");
    expect(user).not.toContain("stored notes");
    expect(await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft_from_notes", notes: " " }) })).toMatchObject({ code: "notes_required" });
  });

  it("drafts a freeform section when the document has no type, finding neighbours by heading", async () => {
    mocks.getType.mockResolvedValue(null);
    const d = await createDocument(T, "ann", { content_json: docOf(heading("Intro", "", null), para("Hello."), heading("Lessons", "", null), para("")) });
    const res = await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_new", req: req({ mode: "draft", heading: "Lessons", specKey: null }) });
    expect(res.ok && res.response.section.spec_key).toBeNull();
    const user = mocks.claudeText.mock.calls[0][0].user as string;
    expect(user).toContain('Guidance: Write the "Lessons" section.');
    expect(user).toContain('<previous_section heading="Intro">');
  });

  it("reports a missing document, an unconfigured model, and propagates model errors", async () => {
    expect(await generateSection({ teamId: T, agent: "ann", documentId: "00000000-0000-4000-8000-000000000000", sectionId: "s_1", req: req({ mode: "draft" }) })).toMatchObject({ code: "not_found", status: 404 });
    const d = await makeDoc();
    expect(await generateSection({ teamId: "org:b", agent: "bob", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft" }) })).toMatchObject({ code: "not_found" });
    mocks.configured.value = false;
    expect(await generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft" }) })).toMatchObject({ code: "not_configured", status: 503 });
    mocks.configured.value = true;
    mocks.claudeText.mockRejectedValue(new Error("boom"));
    await expect(generateSection({ teamId: T, agent: "ann", documentId: d.id, sectionId: "s_bud", req: req({ mode: "draft" }) })).rejects.toThrow("boom");
    expect(await getSectionMeta(T, d.id, "s_bud")).toMatchObject({ status: "empty" });
  });
});

describe("dropRepeatedHeading", () => {
  it("drops only a first-line heading that matches", () => {
    expect(dropRepeatedHeading("## Budget\n\nText", "Budget")).toBe("Text");
    expect(dropRepeatedHeading("**Budget**\nText", "budget")).toBe("Text");
    expect(dropRepeatedHeading("Budget matters.\nText", "Budget")).toBe("Budget matters.\nText");
    expect(dropRepeatedHeading("### Line items\nText", "Budget")).toBe("### Line items\nText");
  });
});

describe("neighboursOf", () => {
  it("gives a parent's own text as the previous section of its first typed sub-section", () => {
    const doc = docOf(
      heading("Specific Aims", "s_aims", "specific-aims"),
      para("Aim one."),
      heading("Research Strategy", "s_rs", "research-strategy"),
      para("Overview."),
      heading("Significance", "s_sig", "significance", 3),
      para(""),
      heading("Approach", "s_app", "approach", 3),
      para("Methods by aim."),
    );
    const sections = listSections(doc, { own: true });
    const n = neighboursOf(sections, findTarget(sections, "s_sig", "Significance"));
    expect(n.previous).toEqual({ heading: "Research Strategy", text: "Overview." });
    expect(n.next).toEqual({ heading: "Approach", text: "Methods by aim." });
  });
});
