// Live check of the classify.type task against the real model. Runs only with
// SASHA_LIVE_TESTS=1 and ANTHROPIC_API_KEY set:
//   SASHA_LIVE_TESTS=1 npx vitest run src/lib/classifier/classify.live.test.ts
// Logs latency and token counts only (never keys or other env values).
// With SASHA_RECORD_FIXTURES=1 as well, the model's reply (and the keys it was
// offered) is written to __fixtures__/classify.type.recorded.json, which
// recorded.test.ts replays offline.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env: rely on the environment.
}
// Keep the run in process memory (documents, catalog, audit) even when .env names a database.
delete process.env.POSTGRES_URL;

import { fileTypes } from "@/catalog/files";
import { createDocument } from "@/lib/documents/store";
import { claudeJson } from "@/lib/llm/claude";
import { docOf, heading, para } from "@/lib/sections/test-fixtures";
import { classifyDocument, ClassifyModelOutput, normalizeResult } from "./classify";
import { classifySystemForTeam, classifyUser } from "./prompt";

const live = process.env.SASHA_LIVE_TESTS === "1" && !!process.env.ANTHROPIC_API_KEY;

const DRAFT = docOf(
  heading("Riverside Path Restoration", "s_1"),
  para(
    "We propose that the Parks Committee approve a twelve-month project to restore the eroded riverside footpath between Mill Bridge and the boathouse. " +
      "The path is used by around 900 walkers a week, and two sections have collapsed since last winter's floods, forcing a detour along the main road.",
  ),
  heading("Objectives", "s_2"),
  para(
    "Rebuild 400 metres of path with a permeable surface; stabilize the bank with willow spiling; install four drainage culverts; reopen the full route before next summer. " +
      "Success will be judged by reopening on schedule, no further collapses through one winter, and footfall returning to its earlier level.",
  ),
  heading("Approach and timeline", "s_3"),
  para(
    "Months one to two cover the survey and permits; months three to six the bank works, done outside the bird-nesting season; months seven to ten the surfacing and culverts; " +
      "months eleven and twelve the monitoring and handover to the maintenance team. Volunteers from the Friends of the River will help with planting.",
  ),
  heading("Budget", "s_4"),
  para(
    "The total request is £68,000: £31,000 for groundworks, £14,000 for surfacing, £9,000 for culverts, £6,000 for willow and planting, and £8,000 for survey, permits and contingency. " +
      "We ask the committee to approve the project and release the first tranche of funding at its next meeting.",
  ),
);

const ACCEPTABLE = new Set(["proposal", ...fileTypes().filter((t) => t.family === "grant").map((t) => t.key)]);

describe.skipIf(!live)("classify.type (live)", () => {
  it("classifies a proposal-like draft and reuses the cached catalog prompt", { timeout: 120_000 }, async () => {
    const team = "org:live-classifier";
    const doc = await createDocument(team, "live-test", { title: "Riverside path proposal", content_json: DRAFT });

    const t0 = Date.now();
    const out = (await classifyDocument(team, doc.id, { trigger: "manual", force: true, agent: "live-test" }))!;
    const firstMs = Date.now() - t0;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ran: true });
    const top = out.body.view.state.last!.candidates[0];
    expect(top).toBeDefined();
    expect(ACCEPTABLE.has(top.key)).toBe(true);
    expect(top.confidence).toBeGreaterThanOrEqual(0.5);
    expect(out.body.view.state.last!.freeform).toBe(false);

    // The same system prompt again: the catalog prefix should come from the cache.
    const { system, keys } = await classifySystemForTeam(team);
    const user = classifyUser({ title: doc.title, notes: doc.notes, text: doc.content_text });
    const t1 = Date.now();
    const second = await claudeJson({ task: "classify.type", system, user, schema: ClassifyModelOutput, agent: "live-test", documentId: doc.id });
    const secondMs = Date.now() - t1;
    const again = normalizeResult(second.data, keys);
    console.log(
      `[classify.live] first ${firstMs} ms; second ${secondMs} ms, input ${second.usage.input_tokens}, output ${second.usage.output_tokens}, ` +
        `cache read ${second.usage.cache_read_input_tokens}, cache write ${second.usage.cache_creation_input_tokens}; ` +
        `top confidence ${top.confidence}, candidates ${out.body.view.state.last!.candidates.length}`,
    );
    expect(ACCEPTABLE.has(again.candidates[0]?.key ?? "")).toBe(true);
    expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0);

    if (process.env.SASHA_RECORD_FIXTURES === "1") {
      const recorded = { recorded_at: new Date().toISOString(), model: second.usage.model, keys: [...keys].sort(), data: second.data };
      writeFileSync(new URL("./__fixtures__/classify.type.recorded.json", import.meta.url), JSON.stringify(recorded, null, 2) + "\n");
    }
  });
});
