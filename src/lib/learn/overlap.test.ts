import { describe, expect, it } from "vitest";
import { OVERLAP_MIN_WORDS } from "./contract";
import { draftStrings, findOverlaps, mapDraftStrings, removeOverlap, REWRITE_NOTE, shingles, tokenize, unacknowledgedOverlaps } from "./overlap";
import { EXAMPLE_A, typeDraft, workflowDraft } from "./__fixtures__/learn-reply";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import type { WorkflowDefinition } from "@/catalog/workflow-schema";

const COPIED = "because the current unit failed its annual safety inspection last spring and cannot be repaired";

const draft = (guidance: string) => ({
  type: typeDraft({ sections: [{ key: "summary", heading: "Summary", order: 10, guidance, elements: [] }] }) as unknown as DocumentTypeDefinition,
});

describe("tokenize and shingles", () => {
  it("lowercases, drops punctuation and apostrophes, keeps offsets", () => {
    const t = tokenize("Don’t  STOP, now!");
    expect(t.map((x) => x.word)).toEqual(["dont", "stop", "now"]);
    expect("Don’t  STOP, now!".slice(t[1].start, t[1].end)).toBe("STOP");
    expect(shingles("a b c d", 3)).toEqual(new Set(["a b c", "b c d"]));
  });
});

describe("draftStrings / mapDraftStrings", () => {
  it("walks prose with readable paths and skips keys, ids, wiring and provenance", () => {
    const paths = draftStrings({ type: typeDraft() as never, workflow: workflowDraft() as never }).map((s) => s.path);
    expect(paths).toContain("type.sections.summary.guidance");
    expect(paths).toContain("type.rubric.costs_add_up.levels.0.descriptor");
    expect(paths).toContain("workflow.steps.rev.config.reviewers.budget.brief");
    expect(paths).toContain("workflow.steps.chk.config.checklist.signed.question");
    expect(paths.some((p) => p.endsWith(".key") || p.includes(".in.") || p.includes("provenance") || p.endsWith(".node"))).toBe(false);
    const upper = mapDraftStrings({ type: typeDraft() as never }, (_p, v) => v.toUpperCase());
    expect((upper.type as unknown as { key: string; title: string }).key).toBe("equipment-request");
    expect((upper.type as unknown as { title: string }).title).toBe("EQUIPMENT REQUEST");
  });
});

describe("outcome values", () => {
  const SENTENCE = "Ready when Priya Raman approves; led the platform team, worked with billing on the quarterly migration plan.";
  const withOutcome = (description: string) => {
    const wf = workflowDraft({ outcome: { label: "Outcome", values: [{ key: "ready", label: "Ready", description }, { key: "revise", label: "Revise" }] } });
    return { workflow: wf as unknown as WorkflowDefinition };
  };

  it("walks an outcome value's label and description, but not decide or enum key lists", () => {
    const paths = draftStrings(withOutcome("Ready to submit.")).map((s) => s.path);
    expect(paths).toEqual(expect.arrayContaining(["workflow.outcome.values.ready.label", "workflow.outcome.values.ready.description"]));
    expect(paths.some((p) => p.endsWith(".key") || /config\.values\./.test(p))).toBe(false);
  });

  it("flags a run copied into an outcome description", () => {
    const flags = findOverlaps(withOutcome(SENTENCE), [`# Example\n\n${SENTENCE}`]);
    expect(flags.map((f) => f.path)).toEqual(["workflow.outcome.values.ready.description"]);
  });
});

describe("findOverlaps", () => {
  it(`flags a run of ${OVERLAP_MIN_WORDS}+ words copied from an example, ignoring case and punctuation`, () => {
    const flags = findOverlaps(draft(`Explain the need, e.g. BECAUSE the current unit failed its annual safety-inspection last spring and cannot be repaired.`), ["x", EXAMPLE_A]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ path: "type.sections.summary.guidance", example: 1, words: 15 });
    expect(flags[0].text).toBe("BECAUSE the current unit failed its annual safety-inspection last spring and cannot be repaired");
  });

  it("does not flag shorter runs or paraphrase", () => {
    expect(findOverlaps(draft("Say the current unit failed its annual safety inspection and why."), [EXAMPLE_A])).toEqual([]);
    expect(findOverlaps(draft("Explain what failed, when, and why it cannot be fixed."), [EXAMPLE_A])).toEqual([]);
  });

  it("merges overlapping windows into one run and reports a run once across examples", () => {
    const flags = findOverlaps(draft(`Start. ${COPIED}. End.`), [EXAMPLE_A, EXAMPLE_A]);
    expect(flags).toHaveLength(1);
    expect(flags[0].example).toBe(0);
  });

  it("checks workflow strings too", () => {
    const w = workflowDraft();
    const steps = (w.steps as Array<{ id: string; config?: Record<string, unknown> }>).map((s) => (s.id === "dec" ? { ...s, config: { ...s.config, guidance: `Approve ${COPIED}.` } } : s));
    const flags = findOverlaps({ workflow: { ...w, steps } as unknown as WorkflowDefinition }, [EXAMPLE_A]);
    expect(flags.map((f) => f.path)).toEqual(["workflow.steps.dec.config.guidance"]);
  });
});

describe("removeOverlap and acknowledgement", () => {
  it("takes the copied run out of its field, or leaves a note when nothing is left", () => {
    const d = draft(`Say what is needed (${COPIED}).`);
    const [flag] = findOverlaps(d, [EXAMPLE_A]);
    const out = removeOverlap(d, flag);
    expect(out.type.sections[0].guidance).toBe("Say what is needed.");
    expect(findOverlaps(out, [EXAMPLE_A])).toEqual([]);
    const only = draft(COPIED);
    expect(removeOverlap(only, findOverlaps(only, [EXAMPLE_A])[0]).type.sections[0].guidance).toBe(REWRITE_NOTE);
  });

  it("treats a kept path as acknowledging every flag on it", () => {
    const flags = [
      { path: "a", text: "x", words: 12, example: 0 },
      { path: "b", text: "y", words: 12, example: 0 },
    ];
    expect(unacknowledgedOverlaps(flags, ["a"])).toEqual([flags[1]]);
  });
});
