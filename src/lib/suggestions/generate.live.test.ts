// Live check of the suggest.items task against the real model. Runs only with
// SASHA_LIVE_TESTS=1 and ANTHROPIC_API_KEY set:
//   SASHA_LIVE_TESTS=1 npx vitest run src/lib/suggestions/generate.live.test.ts
// Logs latency and token counts only (never keys or other env values).
// With SASHA_RECORD_FIXTURES=1 as well, the raw reply (with the item labels,
// source ids, data table ids and section keys it was given) is written to
// __fixtures__/suggest.items.recorded.json, which recorded.test.ts replays offline.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env: rely on the environment.
}
// Keep the run in process memory (documents, sources, audit) even when .env names a database.
delete process.env.POSTGRES_URL;

import { fileTypeByKey } from "@/catalog/files";
import { columnKey } from "@/lib/data/contract";
import { linkTable, listTables, replaceSourceTables } from "@/lib/data/store";
import { createDocument, updateDocument } from "@/lib/documents/store";
import { claudeJson } from "@/lib/llm/claude";
import { createSource, linkSource, setSummary } from "@/lib/sources/store";
import { typeNeeds } from "./diff";
import { generateSuggestions, promptTable } from "./generate";
import { SUGGEST_SYSTEM, SuggestModelOutput, suggestUserPrompt } from "./prompt";

const live = process.env.SASHA_LIVE_TESTS === "1" && !!process.env.ANTHROPIC_API_KEY;
const T = "org:live";

const NOTES =
  "This is our application to the Hartley Foundation for the riverside path restoration. The foundation requires last year's audited financials " +
  "with every application, and wants to see that the parish council has formally backed the project. We also need the contractor's quote for the " +
  "bank works and an estimate of how many people use the path each week.";

describe.skipIf(!live)("suggest.items (live)", () => {
  it("proposes a financials item from the notes and returns valid coverage indices", async () => {
    const d = await createDocument(T, "live", { type_key: "proposal", title: "Riverside path restoration" });
    await updateDocument(T, d.id, "live", { notes: NOTES });
    const a = await createSource(T, "live", { kind: "note", title: "Contractor quote", extraction_status: "ready" });
    await setSummary(T, a.id, "A quote from Greenbank Contractors for rebuilding 400 m of riverside path and stabilizing the bank: £38,400 including VAT, valid for 90 days.");
    const b = await createSource(T, "live", { kind: "note", title: "Path survey", extraction_status: "ready" });
    await setSummary(T, b.id, "A survey of the riverside path counting about 900 walkers a week in spring, with two collapsed sections since last winter's floods.");
    await linkSource(T, "live", d.id, a.id);
    await linkSource(T, "live", d.id, b.id);
    // A spreadsheet with the project timeline, linked as a data table (Phase 5).
    const sheet = await createSource(T, "live", { kind: "file", title: "Project plan.xlsx", filename: "Project plan.xlsx", extraction_status: "ready" });
    const labels: Array<[string, "text" | "date"]> = [["Milestone", "text"], ["Target date", "date"], ["Owner", "text"]];
    await replaceSourceTables(T, sheet.id, "live", [
      {
        match_key: "sheet:Timeline",
        name: "Project timeline",
        columns: labels.map(([label, type], i) => ({ key: columnKey(i), label, type, inferred: type, unit: null })),
        rows: [
          ["Contractor appointed", "2027-03-01", "Parish clerk"],
          ["Bank stabilization complete", "2027-06-30", "Greenbank"],
          ["Path reopened", "2027-09-15", "Parish council"],
        ],
        extraction_method: "xlsx",
        sheet: "Timeline",
        page: null,
        page_end: null,
        confidence: null,
        notes: "",
        truncated: false,
      },
    ]);
    const [timeline] = await listTables(T, { sourceId: sheet.id });
    await linkTable(T, "live", d.id, timeline.id);

    // The raw reply, to check the indices the model used.
    const items = typeNeeds(fileTypeByKey("proposal")!);
    const started = Date.now();
    const { data, usage } = await claudeJson({
      task: "suggest.items",
      system: SUGGEST_SYSTEM,
      user: suggestUserPrompt({
        items,
        sources: [
          { id: a.id, title: "Contractor quote", summary: "A quote from Greenbank Contractors for rebuilding 400 m of riverside path and stabilizing the bank: £38,400 including VAT, valid for 90 days." },
          { id: b.id, title: "Path survey", summary: "A survey of the riverside path counting about 900 walkers a week in spring, with two collapsed sections since last winter's floods." },
        ],
        tables: [promptTable({ ...timeline, added_by: "live", added_at: timeline.created_at })],
        notes: NOTES,
        type: { title: "Proposal", sections: fileTypeByKey("proposal")!.sections.map((s) => ({ key: s.key, heading: s.heading })) },
      }),
      schema: SuggestModelOutput,
      agent: "live",
    });
    console.log(`suggest.items raw: ${Date.now() - started} ms, in ${usage.input_tokens}, out ${usage.output_tokens}, cache read ${usage.cache_read_input_tokens}`);
    if (process.env.SASHA_RECORD_FIXTURES === "1") {
      const recorded = {
        recorded_at: new Date().toISOString(),
        model: usage.model,
        type_key: "proposal",
        items: items.map((i) => i.label),
        source_ids: [a.id, b.id],
        table_ids: [timeline.id],
        section_keys: fileTypeByKey("proposal")!.sections.map((s) => s.key),
        data,
      };
      writeFileSync(new URL("./__fixtures__/suggest.items.recorded.json", import.meta.url), JSON.stringify(recorded, null, 2) + "\n");
    }
    expect(data.coverage.length).toBeGreaterThan(0);
    for (const c of data.coverage) {
      expect(c.item).toBeGreaterThanOrEqual(1);
      expect(c.item).toBeLessThanOrEqual(items.length);
      if (c.status === "missing") continue;
      // A table only ever covers a data item.
      if (c.source_id === timeline.id) expect(items[c.item - 1].kind).toBe("data");
      else expect([a.id, b.id]).toContain(c.source_id);
    }

    // The whole service, end to end.
    const t2 = Date.now();
    const r = (await generateSuggestions(T, d.id, { agent: "live" }))!;
    console.log(`generateSuggestions: ${Date.now() - t2} ms, ${r.suggestions.length} suggestions, ${r.suggestions.filter((s) => s.state === "added").length} covered`);
    expect(r.ran).toBe(true);
    expect(r.error).toBeNull();
    const notes = r.suggestions.filter((s) => s.origin === "notes");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((s) => /financ|account|audit/i.test(s.label))).toBe(true);
    expect(r.suggestions.find((s) => s.label === "Quotes or cost estimates")).toMatchObject({ state: "added", source_id: a.id });
    expect(r.suggestions.find((s) => s.label === "Milestone dates")).toMatchObject({ state: "added", data_table_id: timeline.id, source_id: null });
  }, 120_000);
});
