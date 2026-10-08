import { beforeEach, describe, expect, it } from "vitest";
import { fileTypeByKey } from "@/catalog/files";
import { columnKey } from "@/lib/data/contract";
import { linkTable, listTables, replaceSourceTables } from "@/lib/data/store";
import { putSectionNotes } from "@/lib/documents/section-store";
import { createSource } from "@/lib/sources/store";
import { NodeError } from "../context";
import { dataList, docNotes, docRead, readRequirements, sourcesList, sourcesRead } from "./readers";
import { AGENT, ctxFor, heading, makeDocument, nodeOf, para, resetStores, TEAM } from "./test-fixtures";
import type { DocSnapshot, SourcesSnapshot, TableView } from "./types";

beforeEach(resetStores);

const body = [
  para("Prepared for the council."),
  heading("Summary", "sec-sum", "summary"),
  para("We ask for £40,000 to restore the path."),
  heading("Budget", "sec-bud", "budget"),
  para(""),
  heading("Detail", "sec-det", null, 3),
  para("Line items follow."),
  heading("Header", "sec-hdr", "memo-header"),
];

describe("doc.read", () => {
  it("snapshots the sections with their spec, the type and the empty sections", async () => {
    const { doc } = await makeDocument({ title: "Path", typeKey: "proposal", content: body });
    const out = (await docRead({}, nodeOf("doc.read"), ctxFor(doc.id))) as Record<string, unknown>;
    const d = out.document as DocSnapshot;
    expect(d.typeKey).toBe("proposal");
    expect(d.typeTitle).toBe(fileTypeByKey("proposal")!.title);
    expect(d.preamble).toBe("Prepared for the council.");
    expect(d.sections.map((s) => s.sectionId)).toEqual(["sec-sum", "sec-bud", "sec-det", "sec-hdr"]);
    const summary = d.sections[0];
    expect(summary).toMatchObject({ specKey: "summary", hasContent: true, renderer: "narrative", required: true, wordCount: 8 });
    // The budget's own body has the unkeyed sub-heading's text.
    expect(d.sections[1].hasContent).toBe(true);
    expect(d.type!.sections.map((s) => s.key)).toContain("budget");
    expect(d.type!.rubric.length).toBeGreaterThan(0);
    expect((out.empty_sections as unknown[]).map((s) => (s as { sectionId: string }).sectionId)).toEqual(["sec-hdr"]);
    expect(out.text).toContain('<section id="sec-sum" heading="Summary" spec="summary">');
    // The sub-section is inside its parent's body, so it isn't repeated.
    expect((out.text as string).match(/Line items follow/g)).toHaveLength(1);
  });

  it("marks static sections as never empty work", async () => {
    const { doc } = await makeDocument({ typeKey: null, content: [heading("Notes", "a1", "notes")] });
    const def = { ...fileTypeByKey("proposal")!, sections: [{ ...fileTypeByKey("proposal")!.sections[0], key: "notes", renderer: "static" as const }] };
    const out = (await docRead({}, nodeOf("doc.read"), ctxFor(doc.id, { type: def }))) as Record<string, unknown>;
    expect(out.empty_sections).toEqual([]);
  });
});

describe("doc.notes", () => {
  it("returns the scratchpad and the notes of sections that still exist", async () => {
    const { doc } = await makeDocument({ content: body, notes: "Ask about match funding." });
    await putSectionNotes(TEAM, doc.id, "sec-bud", { notes: "Quote from Greenbank." });
    await putSectionNotes(TEAM, doc.id, "gone", { notes: "Orphan." });
    const out = (await docNotes({}, nodeOf("doc.notes"), ctxFor(doc.id))) as { notes: { scratchpad: string; sections: unknown[] }; text: string };
    expect(out.notes.scratchpad).toBe("Ask about match funding.");
    expect(out.notes.sections).toEqual([{ sectionId: "sec-bud", heading: "Budget", notes: "Quote from Greenbank." }]);
    expect(out.text).toContain("<notes>");
  });
});

describe("sources", () => {
  it("sources.list keeps ready sources; sources.read returns passages with their source ids and honours nameContains", async () => {
    const { doc, sources } = await makeDocument({
      content: body,
      sources: [
        { title: "Contractor quote", summary: "A quote for the bank works.", passages: ["Rebuilding 400 m of path costs £38,400."] },
        { title: "Path survey", summary: "Walker counts.", role: "evidence", passages: ["About 900 walkers a week."] },
      ],
    });
    const pending = await createSource(TEAM, AGENT, { kind: "note", title: "Draft", extraction_status: "pending" });
    const { linkSource } = await import("@/lib/sources/store");
    await linkSource(TEAM, AGENT, doc.id, pending.id);

    const list = (await sourcesList({}, nodeOf("sources.list"), ctxFor(doc.id))) as { sources: Array<{ id: string }> };
    expect(list.sources.map((s) => s.id)).toEqual(sources.map((s) => s.id));

    const read = (await sourcesRead({}, nodeOf("sources.read"), ctxFor(doc.id))) as { sources: SourcesSnapshot; text: string };
    expect(read.sources.passages).toEqual([
      { id: sources[0].passages[0].id, sourceId: sources[0].id, page: 1, text: "Rebuilding 400 m of path costs £38,400." },
      { id: sources[1].passages[0].id, sourceId: sources[1].id, page: 1, text: "About 900 walkers a week." },
    ]);
    expect(read.text).toContain(`[${sources[0].passages[0].id}]`);

    const only = (await sourcesRead({}, nodeOf("sources.read", { nameContains: "survey" }), ctxFor(doc.id))) as { sources: SourcesSnapshot; text: string };
    expect(only.sources.sources.map((s) => s.title)).toEqual(["Path survey"]);
    expect(only.sources.passages.map((p) => p.sourceId)).toEqual([sources[1].id]);
    expect(only.text).not.toContain("Contractor quote");
  });
});

describe("data.list", () => {
  it("returns linked tables with their first rows", async () => {
    const { doc } = await makeDocument({ content: body });
    const sheet = await createSource(TEAM, AGENT, { kind: "file", title: "Budget.xlsx", filename: "Budget.xlsx", extraction_status: "ready" });
    await replaceSourceTables(TEAM, sheet.id, AGENT, [
      {
        match_key: "sheet:Budget",
        name: "Budget",
        columns: [["Line", "text"], ["Amount", "currency"]].map(([label, type], i) => ({ key: columnKey(i), label, type: type as "text", inferred: type as "text", unit: null })),
        rows: [["Bank works", "38400"], ["Signage", "1600"], ["Total", "40000"]],
        extraction_method: "xlsx",
        sheet: "Budget",
        page: null,
        page_end: null,
        confidence: null,
        notes: "",
        truncated: false,
      },
    ]);
    const [t] = await listTables(TEAM, { sourceId: sheet.id });
    await linkTable(TEAM, AGENT, doc.id, t.id);
    const out = (await dataList({}, nodeOf("data.list", { maxRows: 2 }), ctxFor(doc.id))) as { tables: TableView[]; text: string };
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0]).toMatchObject({ id: t.id, name: "Budget", sourceTitle: "Budget.xlsx", rowCount: 3, rows: [["Bank works", "38400"], ["Signage", "1600"]] });
    expect(out.text).toContain(`<table id="${t.id}"`);
    expect(out.text).toContain("1 more rows not shown");
  });
});

describe("requirements.read", () => {
  it("fails on an unknown set or item, and reads nothing for a type with no sets", () => {
    expect(() => readRequirements(["no-such-set"], [], null)).toThrow(NodeError);
    expect(() => readRequirements([], ["no-such-set#x"], null)).toThrow(/unknown requirement/);
    expect(readRequirements([], [], "no-such-type")).toEqual({ sets: [], items: [] });
  });
});
