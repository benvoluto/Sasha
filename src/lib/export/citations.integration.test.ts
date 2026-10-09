// End to end across the Phase 7 tracks, with the real in-memory stores, the
// real catalog and the real routes (dev auth bypass); only Claude is mocked.
// A section is drafted with [[p:ID]] markers, the server verifies them, the
// editor's conversion turns them into citation marks, a rubric-style fix
// rewrites the section with its markers sent back (the check panel's Apply
// goes through the same generate call), a data table is inserted with its
// source line, and the stored document exports to Markdown, Word and print HTML with one
// numbered reference per source and one footnote per citation occurrence.

import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claudeText: vi.fn() }));
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeText: mocks.claudeText,
  claudeConfigured: () => true,
}));

import { GET as exportRoute } from "@/app/api/documents/[id]/export/route";
import { POST as generateRoute } from "@/app/api/documents/[id]/sections/[sectionId]/generate/route";
import { collectCitations, type CitationReport } from "@/lib/citations/contract";
import { columnKey } from "@/lib/data/contract";
import { tableSnapshotNodes } from "@/lib/data/snapshot";
import { getTableRows, listTables, replaceSourceTables, resetDataStore } from "@/lib/data/store";
import { DEV_USER } from "@/lib/dev-auth";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { createDocument, getDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { teamIdFor } from "@/lib/documents/team";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import type { SectionGenerateResponse } from "@/lib/sections/contract";
import { docOf, heading, para } from "@/lib/sections/test-fixtures";
import { passagePrefix } from "@/lib/sources/pages";
import { createSource, linkSource, replacePassages, resetSourceStore } from "@/lib/sources/store";

const TEAM = teamIdFor(DEV_USER.userId, null);
const reply = (text: string) => ({ text, usage: {} });

const generate = async (docId: string, sectionId: string, body: unknown) => {
  const res = await generateRoute(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: docId, sectionId }) });
  return { status: res.status, json: (await res.json()) as SectionGenerateResponse & { error?: string } };
};
const exportAs = (docId: string, format: string) => exportRoute(new Request(`https://sasha.app/api/documents/${docId}/export?format=${format}`), { params: Promise.resolve({ id: docId }) });

/** The editor's insert: the section's body replaced by the converted blocks (sectionBodyRange, on JSON). */
function replaceBody(doc: PMNode, sectionId: string, blocks: PMNode[]): PMNode {
  const content = doc.content ?? [];
  const at = content.findIndex((n) => n.type === "heading" && n.attrs?.sectionId === sectionId);
  let end = at + 1;
  while (end < content.length && content[end].type !== "heading") end++;
  return { ...doc, content: [...content.slice(0, at + 1), ...blocks, ...content.slice(end)] };
}

const cited = (n: PMNode): Array<{ text: string; keys: string[] }> => {
  const own = n.type === "text" && n.marks?.some((m) => m.type === "citation") ? [{ text: n.text ?? "", keys: n.marks.filter((m) => m.type === "citation").map((m) => String(m.attrs?.passageId ?? m.attrs?.dataTableId)) }] : [];
  return [...own, ...(n.content ?? []).flatMap(cited)];
};

async function seed() {
  const doc = await createDocument(TEAM, DEV_USER.email, {
    title: "River Plan",
    type_key: "policy-decision-memo",
    content_json: docOf(heading("Background", "s_bg", "background"), para(""), heading("Options", "s_opt", "options"), para("Two options are open.")),
  });
  const study = await createSource(TEAM, DEV_USER.email, { kind: "note", title: "Transit study", extracted_text: "x", extraction_status: "ready" });
  const minutes = await createSource(TEAM, DEV_USER.email, { kind: "note", title: "Council minutes", extracted_text: "x", extraction_status: "ready" });
  const A0 = `${passagePrefix(study.id)}.P0`;
  const A1 = `${passagePrefix(study.id)}.P1`;
  const B0 = `${passagePrefix(minutes.id)}.P0`;
  await replacePassages(TEAM, study.id, [
    { id: A0, idx: 0, page: 4, start_offset: 0, end_offset: 42, text: "Demand for river transit rose 12% in 2025." },
    { id: A1, idx: 1, page: 5, start_offset: 43, end_offset: 80, text: "Fares held steady through the year." },
  ]);
  await replacePassages(TEAM, minutes.id, [{ id: B0, idx: 0, page: null, start_offset: 0, end_offset: 50, text: "Ridership doubled downtown while fares held steady." }]);
  await linkSource(TEAM, DEV_USER.email, doc.id, study.id);
  await linkSource(TEAM, DEV_USER.email, doc.id, minutes.id);

  const sheet = await createSource(TEAM, DEV_USER.email, { kind: "file", title: "Budget.csv" });
  await linkSource(TEAM, DEV_USER.email, doc.id, sheet.id);
  await replaceSourceTables(TEAM, sheet.id, DEV_USER.email, [
    {
      match_key: "csv",
      name: "Budget 2026",
      columns: [0, 1].map((i) => ({ key: columnKey(i), label: i ? "Cost" : "Item", type: "text" as const, inferred: "text" as const, unit: null })),
      rows: [
        ["Boats", "$40k"],
        ["Staff", "$10k"],
      ],
      extraction_method: "csv" as const,
      sheet: null,
      page: null,
      page_end: null,
      confidence: null,
      notes: "",
      truncated: false,
    },
  ]);
  return { doc, A0, A1, B0, sheetId: sheet.id };
}

describe("citations from drafting to export", () => {
  const bypass = process.env.SASHA_DEV_AUTH_BYPASS;
  beforeAll(() => {
    process.env.SASHA_DEV_AUTH_BYPASS = "1";
  });
  afterAll(() => {
    if (bypass === undefined) delete process.env.SASHA_DEV_AUTH_BYPASS;
    else process.env.SASHA_DEV_AUTH_BYPASS = bypass;
  });
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    resetDataStore();
    mocks.claudeText.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("drafts with markers, keeps them through a fix, and exports footnotes and references to Markdown and Word", async () => {
    const { doc, A0, A1, B0, sheetId } = await seed();

    // 1. Draft: the model cites three passages (one with a quote) and invents one id.
    mocks.claudeText.mockResolvedValueOnce(
      reply(
        [
          `Demand for river transit rose 12% in 2025.[[p:${A0}|rose 12% in 2025]] Fares held steady.[[p:${A1}]][[p:${B0}]]`,
          "",
          `- Ridership doubled downtown.[[p:${B0}]]`,
          "- Costs stayed flat. [[p:S00000000.P9]]",
        ].join("\n"),
      ),
    );
    const draft = await generate(doc.id, "s_bg", { mode: "draft", heading: "Background", level: 2, specKey: "background", body: "" });
    expect(draft.status).toBe(200);
    const report: CitationReport = draft.json.citations!;
    expect(report.kept).toBe(4);
    expect(report.dropped).toEqual([{ raw: "[[p:S00000000.P9]]", passageId: "S00000000.P9", reason: "unknown_passage" }]);
    expect(report.passages[A0]).toMatchObject({ sourceTitle: "Transit study", page: 4, quote: "rose 12% in 2025" });
    // The model was shown the linked passages and told how to cite them.
    const call = mocks.claudeText.mock.calls[0][0];
    expect(call.system).toContain("[[p:ID]]");
    expect(call.user).toContain(`[${A0}]`);

    // 2. The editor converts the reply: verified markers become marks, the unknown one is gone.
    let content = replaceBody((await getDocument(TEAM, doc.id))!.content_json as PMNode, "s_bg", sectionBlocksFromMarkdown(draft.json.markdown, 2, { citations: report }));
    expect(JSON.stringify(content)).not.toContain("[[p:");
    expect(cited(content)).toEqual([
      { text: "Demand for river transit rose 12% in 2025.", keys: [A0] },
      { text: "Fares held steady.", keys: [A1, B0] },
      { text: "Ridership doubled downtown.", keys: [B0] },
    ]);
    expect(listSections(content, { own: true }).find((s) => s.sectionId === "s_bg")?.bodyText).toContain("Costs stayed flat.");

    // 3. A rubric fix (Apply): a rewrite whose body carries the section's citations as markers.
    const sent = draft.json.markdown;
    mocks.claudeText.mockResolvedValueOnce(reply(`${sent.split("\n\n")[0]} Funding beyond 2026 is not yet agreed.\n\n${sent.split("\n\n")[1]}`));
    const fix = await generate(doc.id, "s_bg", { mode: "rewrite", heading: "Background", level: 2, specKey: "background", body: sent, instruction: "Say what is still undecided about funding." });
    expect(fix.status).toBe(200);
    expect(mocks.claudeText.mock.calls[1][0].user).toContain(`[[p:${A0}]]`);
    expect(fix.json.citations).toMatchObject({ kept: 4, dropped: [] });
    content = replaceBody(content, "s_bg", sectionBlocksFromMarkdown(fix.json.markdown, 2, { citations: fix.json.citations }));
    expect(cited(content).map((c) => c.keys)).toEqual([[A0], [A1, B0], [B0]]);

    // 4. Insert table: the snapshot and its source line (link plus table citation) after the options.
    const [table] = await listTables(TEAM, { sourceId: sheetId });
    const rows = (await getTableRows(TEAM, table.id, 0, 10))!;
    content = { ...content, content: [...(content.content ?? []), ...tableSnapshotNodes({ table, rows }, { rows: 10, at: "2026-10-08T00:00:00.000Z" })] };
    await updateDocument(TEAM, doc.id, DEV_USER.email, { content_json: content } as never);
    const { references } = collectCitations((await getDocument(TEAM, doc.id))!.content_json as PMNode);
    expect(references.map((r) => r.key)).toEqual([`p:${A0}`, `p:${A1}`, `p:${B0}`, `t:${table.id}`]);

    // 5. Markdown: numbers after each cited run, in number order, then the References.
    const mdRes = await exportAs(doc.id, "md");
    expect(mdRes.status).toBe(200);
    const md = await mdRes.text();
    expect(md.startsWith("# River Plan\n\n## Background\n\n")).toBe(true);
    expect(md).toContain("Demand for river transit rose 12% in 2025.[\\[1\\]][1] Fares held steady.[\\[2\\]][2][\\[3\\]][3] Funding beyond 2026 is not yet agreed.");
    expect(md).toContain("- Ridership doubled downtown.[\\[3\\]][3]");
    expect(md).toMatch(/Budget 2026\]\(https:\/\/sasha\.app\/library\?source=[^)]+\)\[\\\[4\\\]\]\[4\]/);
    const refs = md.slice(md.indexOf("## References"));
    expect(refs).toContain("1. Transit study, p. 4");
    expect(refs).toContain("2. Transit study, p. 5");
    expect(refs).toContain("3. Council minutes");
    expect(refs).toContain("4. Table “Budget 2026”, Budget.csv");
    expect(refs).toContain(`[1]: https://sasha.app/library?source=`);
    expect(refs).not.toContain("out of date");

    // 6. Word: one footnote per citation occurrence (1; 2 and 3; 3; 4), and the References list.
    const docxRes = await exportAs(doc.id, "docx");
    expect(docxRes.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await docxRes.arrayBuffer()));
    const body = await zip.file("word/document.xml")!.async("string");
    const notes = await zip.file("word/footnotes.xml")!.async("string");
    expect(body.match(/<w:footnoteReference /g)?.length).toBe(5);
    // The fix sent bare markers, so the footnote quotes the passage rather than the draft's quote.
    expect(notes).toContain("[1] Transit study, p. 4. “Demand for river transit rose 12% in 2025.”");
    expect(notes).toContain("[2] Transit study, p. 5");
    expect(notes).toContain("[3] Council minutes");
    expect(notes).toContain("[4] Table “Budget 2026”, Budget.csv");
    expect(notes.match(/\[3\] Council minutes/g)?.length).toBe(2);
    expect(body).toContain(">References<");
    expect(body).toContain("Funding beyond 2026 is not yet agreed.");
    expect(body).not.toContain("[[p:");

    // 7. Print HTML (what the PDF is rendered from): superscripts that link to matching endnotes.
    const htmlRes = await exportAs(doc.id, "html");
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    for (const n of [1, 2, 3, 4]) {
      expect(html).toContain(`<sup class="cite"><a href="#ref-${n}">${n}</a></sup>`);
      expect(html).toContain(`<li id="ref-${n}"`);
    }
    expect(html.match(/<sup class="cite">/g)?.length).toBe(5);
  });
});

