// Contract test over a real classify.type reply, recorded from the live test
// (SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1 npx vitest run src/lib/classifier/classify.live.test.ts).
// Pins the shape the model actually returns: it parses with the schema sent
// to the model, uses catalog keys verbatim and survives normalizeResult intact.
// The hand-written edge cases live in __fixtures__/classify.type.edge-cases.json.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileTypes } from "@/catalog/files";
import { ClassifyModelOutput, normalizeResult } from "./classify";
import { ClassifyResult } from "./contract";

const recorded = JSON.parse(readFileSync(new URL("./__fixtures__/classify.type.recorded.json", import.meta.url), "utf8")) as {
  keys: string[];
  data: unknown;
};

describe("classify.type recorded reply", () => {
  it("parses with the model schema and normalizes without losing candidates", () => {
    const data = ClassifyModelOutput.parse(recorded.data);
    const keys = new Set(recorded.keys);
    const result = ClassifyResult.parse(normalizeResult(data, keys));
    expect(result.candidates.length).toBeGreaterThan(0);
    // Every key the model named was one it was offered, written exactly.
    expect(result.candidates).toHaveLength(new Set(data.candidates.map((c) => c.key)).size);
    for (const c of data.candidates) {
      expect(keys.has(c.key)).toBe(true);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
    expect(result.candidates[0].key).toBe("proposal");
    expect(result.freeform).toBe(false);
  });

  it("was recorded against the current file catalog (re-record when it changes)", () => {
    expect(recorded.keys).toEqual(fileTypes().map((t) => t.key).sort());
  });
});
