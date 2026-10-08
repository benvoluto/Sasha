// Live checks of the step nodes' model tasks (web.find, workflow.gate,
// workflow.extract, workflow.trace, workflow.review, workflow.check,
// workflow.decide, coverage.score, rubric.check) against the real model. Runs
// only with SASHA_LIVE_TESTS=1 and ANTHROPIC_API_KEY set:
//   SASHA_LIVE_TESTS=1 npx vitest run src/lib/workflow/nodes/steps.live.test.ts
// Logs latency and token counts only (never keys or other env values). With
// SASHA_RECORD_FIXTURES=1 as well, each reply (with the material it was given)
// is written to __fixtures__/<task>.recorded.json, which recorded.test.ts
// replays offline. web.find needs web search enabled for the organization.

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env: rely on the environment.
}
// Keep the run in process memory (audit) even when .env names a database.
delete process.env.POSTGRES_URL;

import { claudeJson, claudeSearch, type ClaudeUsage } from "@/lib/llm/claude";
import { fixtureName, LIVE_CASES, type Recording } from "./live-cases";

const live = process.env.SASHA_LIVE_TESTS === "1" && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!live)("step node tasks (live)", () => {
  for (const c of LIVE_CASES) {
    it(c.task, async () => {
      const replies: unknown[] = [];
      const searched: string[] = [];
      let usage: ClaudeUsage | null = null;
      const started = Date.now();
      for (const call of c.calls(c.material)) {
        const common = { task: c.task, system: call.system, user: call.user, schema: call.schema, agent: "live" };
        if (call.tools) {
          const out = await claudeSearch({ ...common, tools: call.tools });
          replies.push(out.data);
          searched.push(...out.searchedUrls);
          usage = out.usage;
        } else {
          const out = await claudeJson(common);
          replies.push(out.data);
          usage = out.usage;
        }
      }
      console.log(
        `${c.task}: ${Date.now() - started} ms, ${replies.length} call(s), last: in ${usage?.input_tokens}, out ${usage?.output_tokens}, cache read ${usage?.cache_read_input_tokens}` +
          (c.task === "web.find" ? `, searches ${usage?.web_search_requests ?? 0}, urls ${searched.length}` : ""),
      );
      if (process.env.SASHA_RECORD_FIXTURES === "1") {
        const rec: Recording = { task: c.task, recorded_at: new Date().toISOString(), model: usage?.model ?? "", material: c.material, replies, ...(c.task === "web.find" ? { searched_urls: searched } : {}) };
        mkdirSync(new URL("./__fixtures__/", import.meta.url), { recursive: true });
        writeFileSync(new URL(`./__fixtures__/${fixtureName(c.task)}`, import.meta.url), JSON.stringify(rec, null, 2) + "\n");
      }
      c.verify(c.material, replies, searched);
    }, 240_000);
  }
});
