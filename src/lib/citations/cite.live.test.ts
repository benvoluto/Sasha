// Live check that a section draft over linked sources cites them with markers
// the server can verify. Runs only with SASHA_LIVE_TESTS=1 and ANTHROPIC_API_KEY set:
//   SASHA_LIVE_TESTS=1 npx vitest run src/lib/citations/cite.live.test.ts
// Logs latency and counts only (never keys or other env values). With
// SASHA_RECORD_FIXTURES=1 as well, the model's raw reply and the passages it
// was shown are written to __fixtures__/draft.citations.recorded.json, which
// recorded.test.ts replays offline through verifyMarkers and markCitations.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env: rely on the environment.
}
// Keep the run in process memory (documents, sources, audit) even when .env names a database.
delete process.env.POSTGRES_URL;

import { createDocument } from "@/lib/documents/store";
import { claudeText } from "@/lib/llm/claude";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import { buildGrounding } from "@/lib/sections/grounding";
import { stripFences, systemPrompt, userPrompt } from "@/lib/sections/prompt";
import { docOf, heading, para, testType } from "@/lib/sections/test-fixtures";
import { pagedPassages } from "@/lib/sources/pages";
import { createSource, linkSource, replacePassages } from "@/lib/sources/store";
import { groundingResolver, verifyMarkers } from "./verify";

const live = process.env.SASHA_LIVE_TESTS === "1" && !!process.env.ANTHROPIC_API_KEY;

const LIVE_SOURCES = [
  {
    title: "Riverside path condition survey (2026)",
    text:
      "--- Page 1 ---\nThe riverside footpath between Mill Bridge and the boathouse is 1.2 kilometres long. Two sections, totalling 400 metres, collapsed after the January floods. " +
      "Pedestrian counters recorded an average of 900 walkers a week before the collapse and 310 a week since. The detour along Station Road adds 700 metres and has no pavement for 150 metres.",
  },
  {
    title: "Contractor cost estimate, Bankside Civils",
    text:
      "--- Page 1 ---\nGroundworks for the two collapsed sections are estimated at £31,000. A permeable resin-bound surface for 400 metres is quoted at £14,000. " +
      "Four drainage culverts are estimated at £9,000 including installation. Willow spiling and planting to stabilize the bank is estimated at £6,000. The quote is valid until 30 November 2026.",
  },
];

describe.skipIf(!live)("section draft citations (live)", () => {
  it("cites the linked sources with markers that all verify", { timeout: 180_000 }, async () => {
    const team = "org:live-citations";
    const def = testType();
    const doc = await createDocument(team, "live-test", {
      title: "Riverside path restoration",
      type_key: def.key,
      content_json: docOf(heading("Summary", "s_sum", "summary"), para("We ask the committee to fund the path restoration."), heading("Budget", "s_bud", "budget"), para("")),
    });
    for (const s of LIVE_SOURCES) {
      const src = await createSource(team, "live-test", { kind: "note", title: s.title, extracted_text: s.text, extraction_status: "ready" });
      await replacePassages(team, src.id, pagedPassages(src.id, s.text));
      await linkSource(team, "live-test", doc.id, src.id);
    }

    const spec = def.sections.find((s) => s.key === "budget")!;
    const grounding = await buildGrounding(team, doc.id, { focus: ["Budget", ...spec.elements, ...(spec.sourcesNeeded ?? [])] });
    expect(grounding.passages.length).toBeGreaterThan(1);
    const t0 = Date.now();
    const { text, usage } = await claudeText({
      task: "draft.section",
      system: systemPrompt(def, "draft"),
      user: userPrompt({
        doc: { title: doc.title, outline: [{ heading: "Summary", level: 2, target: false }, { heading: "Budget", level: 2, target: true }] },
        def,
        spec,
        req: { mode: "draft", heading: "Budget" },
        notes: "",
        neighbours: { previous: { heading: "Summary", text: "We ask the committee to fund the path restoration." }, next: null },
        grounding: grounding.block,
      }),
      agent: "live-test",
      documentId: doc.id,
    });
    const ms = Date.now() - t0;
    const reply = stripFences(text);
    const { markdown, report } = await verifyMarkers(reply, groundingResolver(team, doc.id, grounding));
    console.log(`[cite.live] ${ms} ms, input ${usage.input_tokens}, output ${usage.output_tokens}; kept ${report.kept}, dropped ${report.dropped.length} (${report.dropped.map((d) => d.reason).join(", ") || "none"})`);

    expect(report.kept).toBeGreaterThanOrEqual(1);
    expect(report.dropped).toEqual([]);
    const blocks = sectionBlocksFromMarkdown(markdown, 2, { citations: report });
    expect(JSON.stringify(blocks)).not.toContain("[[p:");
    expect(JSON.stringify(blocks)).toContain('"citation"');

    if (process.env.SASHA_RECORD_FIXTURES === "1") {
      const recorded = {
        recorded_at: new Date().toISOString(),
        model: usage.model,
        task: "draft.section",
        reply,
        grounding: {
          sources: grounding.sources.map((s) => ({ id: s.id, title: s.title })),
          passages: grounding.passages.map((p) => ({ id: p.id, idx: p.idx, page: p.page, text: p.text })),
        },
      };
      writeFileSync(new URL("./__fixtures__/draft.citations.recorded.json", import.meta.url), JSON.stringify(recorded, null, 2) + "\n");
    }
  });
});
