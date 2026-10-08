// Contract tests over real replies recorded from the live test
// (SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1 npx vitest run src/lib/workflow/nodes/steps.live.test.ts).
// Each recording carries the material it was given; the replay runs it
// through the node's own parse and check path (schemas, id filtering, quote
// checks) and the same assertions as the live run. A task with no recording
// is skipped.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureName, LIVE_CASES, type Recording } from "./live-cases";

const path = (task: string) => new URL(`./__fixtures__/${fixtureName(task)}`, import.meta.url);

describe("step node tasks (recorded replies)", () => {
  for (const c of LIVE_CASES) {
    const present = existsSync(path(c.task));
    it.skipIf(!present)(c.task, () => {
      const rec = JSON.parse(readFileSync(path(c.task), "utf8")) as Recording;
      expect(rec.task).toBe(c.task);
      expect(rec.replies.length).toBe(c.calls(rec.material).length);
      c.verify(rec.material, rec.replies, rec.searched_urls ?? []);
    });
  }
});
