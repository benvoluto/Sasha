// Contract tests over real rubric.check replies: the step nodes' recording
// (src/lib/workflow/nodes/__fixtures__/rubric.check.recorded.json, a whole
// document) and the check's own section recording
// (__fixtures__/rubric.section.recorded.json, from check.live.test.ts). Each
// reply is replayed through scoreRubric with claudeJson stubbed, and the rows
// the check route would return must satisfy RubricCheckResponse. A missing
// recording is skipped.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const { claudeJson } = vi.hoisted(() => ({ claudeJson: vi.fn() }));
vi.mock("@/lib/llm/claude", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/claude")>()), claudeJson }));

import type { DocSnapshot } from "@/lib/workflow/nodes/types";
import { contains } from "@/lib/workflow/nodes/util";
import { inputsHash, rubricCriteriaFor, scopeSnapshot, scoreRubric } from "./check";
import { RubricCheckResponseShape, type RubricCheckResponse } from "./contract";

type Recording = { task: string; model: string; material: { doc: DocSnapshot; sectionId?: string | null }; replies: unknown[] };

const FIXTURES = [
  { name: "document (step nodes' recording)", url: new URL("../workflow/nodes/__fixtures__/rubric.check.recorded.json", import.meta.url) },
  { name: "section", url: new URL("./__fixtures__/rubric.section.recorded.json", import.meta.url) },
];

/** The route's response for a replayed reply (no stores, no fingerprints). */
async function replay(rec: Recording): Promise<{ response: RubricCheckResponse; checked: DocSnapshot }> {
  const d = rec.material.doc;
  const sectionId = rec.material.sectionId ?? null;
  const section = sectionId ? d.sections.find((s) => s.sectionId === sectionId)! : null;
  const criteria = rubricCriteriaFor(d, section ? { section: { specKey: section.specKey } } : {});
  const checked = section ? scopeSnapshot(d, [section.sectionId]) : d;
  claudeJson.mockReset();
  claudeJson.mockResolvedValue({ data: rec.replies[0], usage: { model: rec.model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  const { results, dropped } = await scoreRubric(d, { criteria, drafted: null, sectionIds: section ? [section.sectionId] : undefined, call: { agent: "replay", documentId: d.id } });
  const response: RubricCheckResponse = {
    scope: section ? "section" : "document",
    sectionId,
    typeKey: d.typeKey,
    typeVersion: d.type?.version ?? null,
    inputsHash: inputsHash(criteria, d.typeKey, d.type?.version ?? null, checked.text),
    cached: false,
    checkedAt: new Date().toISOString(),
    sectionFingerprints: {},
    results,
    droppedEvidence: dropped,
  };
  return { response, checked };
}

describe("rubric.check (recorded replies through scoreRubric)", () => {
  for (const f of FIXTURES) {
    it.skipIf(!existsSync(f.url))(f.name, async () => {
      const rec = JSON.parse(readFileSync(f.url, "utf8")) as Recording;
      expect(rec.task).toBe("rubric.check");
      const { response, checked } = await replay(rec);
      expect(claudeJson).toHaveBeenCalledTimes(1);
      expect(claudeJson.mock.calls[0][0].task).toBe("rubric.check");
      expect(RubricCheckResponseShape.safeParse(response).success).toBe(true);

      const criteria = rubricCriteriaFor(rec.material.doc, response.sectionId ? { section: { specKey: checked.sections[0]?.specKey ?? null } } : {});
      expect(response.results.length).toBeGreaterThanOrEqual(Math.ceil(criteria.length / 2));
      const ids = new Set(checked.sections.map((s) => s.sectionId));
      for (const r of response.results) {
        expect(r.level).toBeGreaterThanOrEqual(Math.min(...r.levels.map((l) => l.score)));
        expect(r.level).toBeLessThanOrEqual(r.maxLevel);
        expect(r.levels[0].score).toBe(r.maxLevel);
        // Every kept quote is in the text that was checked; a fix section is one that was shown.
        for (const e of r.evidence) expect(contains(checked.text, e.quote)).toBe(true);
        if (r.fixSectionId) expect(ids.has(r.fixSectionId)).toBe(true);
        if (!r.fix) expect(r.fixSectionId).toBeNull();
      }
      expect(response.results.some((r) => r.evidence.length > 0)).toBe(true);
    });
  }
});
