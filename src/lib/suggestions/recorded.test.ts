// Contract test over a real suggest.items reply, recorded from the live test
// (SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1 npx vitest run src/lib/suggestions/generate.live.test.ts).
// Pins the conventions the model actually follows: 1-based item numbers in
// range, source ids copied verbatim from the prompt, spec_refs from the type's
// sections, so judgeReply keeps what the model said instead of dropping it.
// The hand-written edge cases live in __fixtures__/suggest.items.edge-cases.json.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileTypeByKey } from "@/catalog/files";
import { typeNeeds } from "./diff";
import { judgeReply } from "./generate";
import { SuggestModelOutput } from "./prompt";

const recorded = JSON.parse(readFileSync(new URL("./__fixtures__/suggest.items.recorded.json", import.meta.url), "utf8")) as {
  type_key: string;
  items: string[];
  source_ids: string[];
  section_keys: string[];
  data: unknown;
};

describe("suggest.items recorded reply", () => {
  const def = fileTypeByKey(recorded.type_key)!;
  const items = typeNeeds(def);

  it("was recorded against the current type's items and sections (re-record when they change)", () => {
    expect(items.map((i) => i.label)).toEqual(recorded.items);
    expect(def.sections.map((s) => s.key)).toEqual(recorded.section_keys);
  });

  it("parses with the model schema and uses 1-based items and verbatim ids", () => {
    const data = SuggestModelOutput.parse(recorded.data);
    expect(data.coverage.length).toBeGreaterThan(0);
    for (const c of data.coverage) {
      expect(Number.isInteger(c.item)).toBe(true);
      expect(c.item).toBeGreaterThanOrEqual(1);
      expect(c.item).toBeLessThanOrEqual(items.length);
      if (c.status === "missing") continue;
      expect(recorded.source_ids).toContain(c.source_id);
    }
    for (const p of data.proposals) if (p.spec_ref !== null) expect(recorded.section_keys).toContain(p.spec_ref);
  });

  it("survives judgeReply: every covered verdict and proposal is kept", () => {
    const data = SuggestModelOutput.parse(recorded.data);
    const sources = recorded.source_ids.map((id, i) => ({ id, title: `Source ${i + 1}` }));
    const out = judgeReply(data, items, sources, new Set(recorded.section_keys));
    const covered = data.coverage.filter((c) => c.status === "covered");
    expect(out.typeItems.filter((i) => i.covered_by)).toHaveLength(new Set(covered.map((c) => c.item)).size);
    for (const c of covered) expect(out.typeItems[c.item - 1].covered_by).toBe(c.source_id);
    for (const c of data.coverage.filter((c) => c.status === "partial")) {
      if (!covered.some((k) => k.item === c.item)) expect(out.typeItems[c.item - 1].reason).toContain("(partly covered by");
    }
    expect(out.proposals.length).toBeGreaterThan(0);
    expect(out.proposals.some((p) => /financ|account|audit/i.test(p.label))).toBe(true);
  });
});
