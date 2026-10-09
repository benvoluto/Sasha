// Contract tests over real replies recorded from the live test
// (SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1 npx vitest run src/lib/workflow/generic/generic.live.test.ts),
// replayed through the same parse and check path the nodes use, plus the
// hand-written edge cases in __fixtures__/generic.edge-cases.json. A missing
// recording skips its test (record it again to restore the check). The
// workflow.tailor fixture is hand-built until a live recording replaces it.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { traceDraft } from "./draft";
import { DRAFT_CASE, draftGrounding, planChunks, planTarget, REWRITE_SECTION } from "./live-cases";
import { DraftTracedReply, RestructurePlanReply } from "./prompts";
import { addedNumbers, planRows } from "./restructure-nodes";
import type { PMNode } from "@/lib/documents/sections";
import type { ExtractedItem } from "../contract";
import { documentLines } from "../lines";
import type { SourcesSnapshot } from "../nodes/types";
import { checkTailorLines } from "./tailor";
import { TailorReply } from "./tailor-prompts";

const fixture = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);
const load = <T>(name: string): T | null => (existsSync(fixture(name)) ? (JSON.parse(readFileSync(fixture(name), "utf8")) as T) : null);

const plan = load<{ section_keys: string[]; parts: Array<string | null>; data: unknown }>("restructure.plan.recorded.json");
const rewrite = load<{ input: typeof REWRITE_SECTION; markdown: string }>("restructure.apply.recorded.json");
const draft = load<{ passage_ids: string[]; data: unknown }>("draft.traced.recorded.json");
const edge = load<Record<string, unknown>>("generic.edge-cases.json")!;
const tailor = load<{ content: PMNode[]; master: SourcesSnapshot; requirements: Array<ExtractedItem & { status: string }>; data: unknown }>("workflow.tailor.recorded.json");

describe("restructure.plan recorded reply", () => {
  it.skipIf(!plan)("was recorded against the current outline and parts, and survives planRows unchanged", () => {
    const target = planTarget();
    const chunks = planChunks();
    expect(target.sections.map((s) => s.key)).toEqual(plan!.section_keys);
    expect(chunks.map((c) => c.heading)).toEqual(plan!.parts);
    const data = RestructurePlanReply.parse(plan!.data);
    const rows = planRows(chunks, data, new Set(plan!.section_keys));
    expect(rows).toHaveLength(chunks.length);
    // The model's own targets are kept: it uses the R ids and the keys verbatim.
    expect(rows.map((r) => r.target)).toEqual(data.rows.map((r) => r.target));
    expect(rows.every((r) => r.reason && !r.reason.startsWith("Not mapped"))).toBe(true);
  });
});

describe("restructure.apply recorded rewrite", () => {
  it.skipIf(!rewrite)("adds no figures, so restructure.rewrite applies it", () => {
    expect(rewrite!.input).toEqual(REWRITE_SECTION);
    expect(rewrite!.markdown.trim().length).toBeGreaterThan(0);
    expect(rewrite!.markdown).not.toMatch(/```/);
    expect(addedNumbers(rewrite!.input.text, rewrite!.markdown)).toEqual([]);
  });
});

describe("draft.traced recorded reply", () => {
  it.skipIf(!draft)("cites only the passages it was shown, so traceDraft keeps every support", () => {
    const grounding = draftGrounding();
    expect(grounding.passages.map((p) => p.id)).toEqual(draft!.passage_ids);
    const data = DraftTracedReply.parse(draft!.data);
    const traced = traceDraft(data, { grounding, sectionId: "s1", sectionNotes: DRAFT_CASE.sectionNotes, scratchpad: DRAFT_CASE.scratchpad });
    const given = data.sentences.reduce((n, s) => n + new Set(s.support.map((r) => (r.kind === "note" ? "note" : r.id))).size, 0);
    expect(traced.trace.reduce((n, t) => n + t.support.length, 0)).toBe(given);
    expect(traced.markdown.length).toBeGreaterThan(40);
    expect(traced.markdown).not.toMatch(/\[S[0-9a-f]{8}\.P\d+\]/);
  });
});

describe("workflow.tailor reply", () => {
  it.skipIf(!tailor)("parses, refers to the lines it was shown, and every line survives the code checks with its passages", () => {
    const lines = documentLines({ type: "doc", content: tailor!.content }).filter((l) => l.sectionId !== null && l.specKey !== "contact");
    const data = TailorReply.parse(tailor!.data);
    const out = checkTailorLines(data, { lines, master: tailor!.master, requirements: tailor!.requirements, maxLines: 25 });
    expect(out.dropped).toEqual([]);
    expect(out.lines).toHaveLength(data.lines.length);
    for (const l of out.lines) {
      expect(lines.some((d) => d.text === l.original)).toBe(true);
      if (l.action === "rewrite" || (l.action === "lead" && l.proposed !== l.original)) expect(l.evidence.every((e) => e.kind === "passage" && e.verified), l.id).toBe(true);
      expect(l.proposed).not.toMatch(/\[S[0-9a-f]{8}\.P\d+\]/);
    }
    // No line for the requirement the master doesn't meet.
    expect(out.lines.flatMap((l) => l.requirementKeys)).not.toContain("I3");
  });
});

describe("hand-written edge cases", () => {
  it("restructure.plan: ids are matched loosely, unknown or wrongly cased keys and missing rows become no home", () => {
    const chunks = planChunks();
    const rows = planRows(chunks, RestructurePlanReply.parse(edge["restructure.plan"]), new Set(planTarget().sections.map((s) => s.key)));
    expect(rows.map((r) => r.target)).toEqual([null, "budget", null, null, null]);
    expect(rows[0].reason).toMatch(/No such section “Summary”/);
    expect(rows[2].reason).toBe("Not mapped by the planner.");
  });

  it("draft.traced: invented ids dropped, markers stripped, blank sentences skipped", () => {
    const traced = traceDraft(DraftTracedReply.parse(edge["draft.traced"]), { grounding: draftGrounding(), sectionId: "s1", sectionNotes: "", scratchpad: "" });
    expect(traced.trace.map((t) => [t.text, t.unsourced])).toEqual([
      ["The path costs £38,400.", false],
      ["It will reopen in July.", true],
    ]);
    expect(traced.markdown).toBe("The path costs £38,400. It will reopen in July.");
  });
});
