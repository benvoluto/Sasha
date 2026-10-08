// Live checks of the generic model tasks against the real model:
// restructure.plan, restructure.apply (rewrite mode's rewording) and
// draft.traced. Runs only with SASHA_LIVE_TESTS=1 and ANTHROPIC_API_KEY set:
//   SASHA_LIVE_TESTS=1 npx vitest run src/lib/workflow/generic/generic.live.test.ts
// Logs latency and token counts only (never keys or other env values). With
// SASHA_RECORD_FIXTURES=1 as well, each raw reply (with what it was given) is
// written to __fixtures__/<task>.recorded.json, which recorded.test.ts replays.

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env: rely on the environment.
}
// Keep the run in process memory (audit) even when .env names a database.
delete process.env.POSTGRES_URL;

import { claudeJson, claudeText, type ClaudeUsage } from "@/lib/llm/claude";
import { stripFences } from "@/lib/sections/prompt";
import { traceDraft } from "./draft";
import { DRAFT_CASE, draftGrounding, planChunks, planTarget, REWRITE_SECTION } from "./live-cases";
import { DRAFT_TRACED_SYSTEM, DraftTracedReply, draftTracedPrompt, RESTRUCTURE_PLAN_SYSTEM, RESTRUCTURE_REWRITE_SYSTEM, RestructurePlanReply, restructurePlanPrompt, restructureRewritePrompt } from "./prompts";
import { addedNumbers, planRows } from "./restructure-nodes";

const live = process.env.SASHA_LIVE_TESTS === "1" && !!process.env.ANTHROPIC_API_KEY;
const record = process.env.SASHA_RECORD_FIXTURES === "1";

function log(task: string, started: number, usage: ClaudeUsage) {
  console.log(`${task}: ${Date.now() - started} ms, in ${usage.input_tokens}, out ${usage.output_tokens}, cache read ${usage.cache_read_input_tokens}`);
}

function save(task: string, body: Record<string, unknown>) {
  if (!record) return;
  const dir = new URL("./__fixtures__/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${task}.recorded.json`, dir), JSON.stringify({ recorded_at: new Date().toISOString(), ...body }, null, 2) + "\n");
}

describe.skipIf(!live)("generic model tasks (live)", () => {
  it("restructure.plan maps every part to a real section key or no home", async () => {
    const target = planTarget();
    const chunks = planChunks();
    const started = Date.now();
    const { data, usage } = await claudeJson({
      task: "restructure.plan",
      system: RESTRUCTURE_PLAN_SYSTEM,
      user: restructurePlanPrompt({ title: "Riverside path memo", targetTitle: target.title, sections: target.sections, chunks }),
      schema: RestructurePlanReply,
      agent: "live",
    });
    log("restructure.plan", started, usage);
    const keys = target.sections.map((s) => s.key);
    save("restructure.plan", { model: usage.model, type_key: "proposal", section_keys: keys, parts: chunks.map((c) => c.heading), data });
    const rows = planRows(chunks, data, new Set(keys));
    expect(data.rows.map((r) => r.id)).toEqual(chunks.map((_, i) => `R${i + 1}`));
    for (const r of data.rows) if (r.target !== null) expect(keys).toContain(r.target);
    expect(rows.find((r) => r.heading === "What it costs")!.target).toBe("budget");
    expect(rows.find((r) => r.heading === "When")!.target).toBe("timeline");
  }, 120_000);

  it("restructure.apply rewords a moved section without adding figures", async () => {
    const started = Date.now();
    const { text, usage } = await claudeText({
      task: "restructure.apply",
      system: RESTRUCTURE_REWRITE_SYSTEM,
      user: restructureRewritePrompt({ heading: REWRITE_SECTION.heading, text: REWRITE_SECTION.text, targetTitle: "Proposal", spec: null }),
      agent: "live",
    });
    log("restructure.apply", started, usage);
    const markdown = stripFences(text);
    save("restructure.apply", { model: usage.model, input: REWRITE_SECTION, markdown });
    expect(addedNumbers(REWRITE_SECTION.text, markdown)).toEqual([]);
    for (const fact of ["38,400", "90", "5,000"]) expect(markdown).toContain(fact);
    expect(markdown.length).toBeLessThan(REWRITE_SECTION.text.length * 2.5);
  }, 300_000);

  it("draft.traced returns sentences whose support cites only the passages it was shown", async () => {
    const grounding = draftGrounding();
    const started = Date.now();
    const { data, usage } = await claudeJson({
      task: "draft.traced",
      system: DRAFT_TRACED_SYSTEM,
      user: draftTracedPrompt({ ...DRAFT_CASE, grounding: grounding.block }),
      schema: DraftTracedReply,
      agent: "live",
    });
    log("draft.traced", started, usage);
    const ids = grounding.passages.map((p) => p.id);
    save("draft.traced", { model: usage.model, passage_ids: ids, data });
    expect(data.sentences.length).toBeGreaterThan(0);
    for (const s of data.sentences) for (const ref of s.support) if (ref.kind === "passage") expect(ids).toContain(ref.id);
    const traced = traceDraft(data, { grounding, sectionId: "s1", sectionNotes: DRAFT_CASE.sectionNotes, scratchpad: DRAFT_CASE.scratchpad });
    expect(traced.trace.some((t) => t.support.some((e) => e.kind === "passage"))).toBe(true);
    expect(traced.markdown).not.toMatch(/\[S[0-9a-f]{8}\.P\d+\]/);
  }, 300_000);
});
