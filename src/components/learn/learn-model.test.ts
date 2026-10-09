import { describe, expect, it } from "vitest";
import type { LearnDraft, LearnExampleRef } from "@/lib/learn/contract";
import {
  applyTypeEdit,
  canLearn,
  findQuote,
  highlightSegments,
  initialReview,
  keepFlag,
  keepPersonalFlag,
  progressLabel,
  refId,
  removeFlag,
  saveBlocker,
  saveRequest,
  togglePick,
  currentOverlaps,
  partsFor,
  withServerValidation,
  typeEditorStart,
} from "./learn-model";
import { parseDefinition } from "@/catalog/schema";

const src = (n: number) => ({ kind: "source" as const, sourceId: `00000000-0000-4000-8000-00000000000${n}` });
const COPIED = "because the current unit failed its annual safety inspection last spring and cannot be repaired";
const EXAMPLE = `## Summary\nThe lab asks for a replacement centrifuge ${COPIED}.`;

function draft(guidance = "Say what is needed."): LearnDraft {
  return {
    examples: [{ index: 0, ref: src(1), title: "A", words: 20, headings: [{ level: 2, text: "Summary" }], text: EXAMPLE, truncated: false }],
    confidence: "low",
    confidenceReason: "One example",
    type: { key: "t", version: 1, title: "T", family: "business", summary: "S.", signals: [], audience: "A", tone: "T", preamble: "P", aliases: [], sections: [{ key: "summary", heading: "Summary", level: 2, order: 10, required: true, guidance, elements: [], sourcesNeeded: [], dataNeeded: [], renderer: "narrative" }], rubric: [], provenance: { source: "Learned from 1 example", url: "", license: "Team", retrieved: "2026-10-08" } },
    workflow: {} as LearnDraft["workflow"],
    requirementSets: [],
    parts: [
      { path: "type.sections.summary", note: "Opens with the ask.", from: [{ example: 0, heading: "Summary", quote: "the lab  asks for a REPLACEMENT" }], shared: true },
      { path: "workflow.steps.chk", note: "Checks the ask.", from: [{ example: 0, heading: null, quote: "replacement centrifuge" }], shared: true },
    ],
    overlaps: [],
    personalDetails: [],
    differences: [],
    nearestType: null,
    validation: { type: [], workflow: [], graph: [], requirementSets: [] },
  };
}

describe("picking examples", () => {
  it("toggles, caps at five, and needs at least one", () => {
    let picked: LearnExampleRef[] = [src(1)];
    picked = togglePick(picked, { kind: "document", documentId: "d" });
    expect(picked.map(refId)).toEqual([refId(src(1)), "document:d"]);
    picked = togglePick(picked, src(1));
    expect(picked.map(refId)).toEqual(["document:d"]);
    for (let i = 2; i <= 7; i++) picked = togglePick(picked, src(i));
    expect(picked).toHaveLength(5);
    expect(canLearn(picked)).toBe(true);
    expect(canLearn([])).toBe(false);
    expect(progressLabel(1000, 2)).toBe("Reading 2 examples…");
    expect(progressLabel(90_000, 1)).toMatch(/workflow/);
  });
});

describe("highlights", () => {
  it("finds quotes ignoring case and whitespace, and splits the text into marked runs", () => {
    expect(findQuote("a  B\nc", "b c")).toEqual([3, 6]);
    expect(findQuote("abc", "zz")).toBeNull();
    const d = draft();
    const segs = highlightSegments(EXAMPLE, d.parts, 0);
    expect(segs.map((s) => s.text).join("")).toBe(EXAMPLE);
    expect(segs.find((s) => s.text === "replacement")!.parts.sort()).toEqual([0, 1]);
    expect(segs.find((s) => s.text === "The lab asks for a ")!.parts).toEqual([0]);
    expect(highlightSegments(EXAMPLE, d.parts, 3)).toEqual([{ text: EXAMPLE, parts: [] }]);
    expect(partsFor(d.parts, "workflow").map((x) => x.index)).toEqual([1]);
  });
});

describe("the author checkpoint", () => {
  it("needs a valid draft, every copied passage kept or removed, and the confirmation", () => {
    const d = draft(`Explain ${COPIED}.`);
    let s = initialReview(d);
    const [flag] = currentOverlaps(s, d.examples);
    expect(flag.path).toBe("type.sections.summary.guidance");
    expect(saveBlocker(s, d)).toMatch(/Keep or remove the copied passage/);
    s = keepFlag(s, flag);
    expect(saveBlocker(s, d)).toMatch(/Confirm you reviewed/);
    s = { ...s, reviewed: true };
    expect(saveBlocker(s, d)).toBeNull();
    expect(saveRequest(s, d, "doc-1")).toMatchObject({ examples: [src(1)], documentId: "doc-1", reviewed: true, keepOverlaps: ["type.sections.summary.guidance"] });

    // Removing instead takes the run out and asks for the confirmation again.
    const removed = removeFlag({ ...initialReview(d), reviewed: true }, flag);
    expect(removed.draft.type.sections[0].guidance).toBe("Explain.");
    expect(removed.reviewed).toBe(false);
    expect(currentOverlaps(removed, d.examples)).toEqual([]);
  });

  it("blocks on validation, except workflow problems when the type is saved alone", () => {
    const d = { ...draft(), validation: { type: [], workflow: ["steps: bad"], graph: [], requirementSets: [] } };
    const s = { ...initialReview(d), reviewed: true };
    expect(saveBlocker(s, d)).toMatch(/Fix the problems/);
    const alone = { ...s, withWorkflow: false };
    expect(saveBlocker(alone, d)).toBeNull();
    expect(saveRequest(alone, d).workflow).toBeUndefined();
  });

  it("re-runs the section-key rule on a type edit, so a section put back clears the save route's error", () => {
    const d = { ...draft(), workflow: { steps: [{ id: "chk", node: "step.check", config: { checklist: [{ key: "k", appliesTo: ["budget"] }] } }] } as unknown as LearnDraft["workflow"] };
    const keyError = 'steps.chk.config: "budget" is not one of the type\'s section keys';
    let s = withServerValidation({ ...initialReview(d), reviewed: true }, { type: [], workflow: [keyError], graph: ["g: other"], requirementSets: [] });
    expect(saveBlocker(s, d)).toMatch(/Fix the problems/);
    const budget = { ...d.type.sections[0], key: "budget", heading: "Budget", order: 20 };
    s = { ...applyTypeEdit(s, { ...d.type, sections: [...d.type.sections, budget] }), reviewed: true };
    expect(s.validation).toEqual({ type: [], workflow: [], graph: ["g: other"], requirementSets: [] });
    // The graph problem is still the server's, so Save stays off until it is resolved.
    expect(saveBlocker(s, d)).toMatch(/Fix the problems/);
    expect(saveBlocker({ ...s, validation: { ...s.validation, graph: [] } }, d)).toBeNull();
    // Removing the section again brings the error back.
    expect(applyTypeEdit(s, d.type).validation.workflow).toEqual([keyError]);
    // Type errors the server returns after an edit are shown and block.
    const typeErr = withServerValidation(s, { type: ["sections: bad"], workflow: [], graph: [], requirementSets: [] });
    expect(saveBlocker({ ...typeErr, reviewed: true }, d)).toMatch(/Fix the problems/);
  });

  it("sends the extraction's flags back as hints, and the names the author keeps (never a pattern)", () => {
    const d = { ...draft(), personalDetails: [{ path: "p", text: "Jane Doe", kind: "name" as const, removed: true }] };
    let s = initialReview(d);
    s = keepPersonalFlag(s, { path: "p", text: "Wechsler Scale", kind: "name", removed: false });
    s = keepPersonalFlag(s, { path: "p", text: "a@b.org", kind: "email", removed: false });
    expect(saveRequest(s, d)).toMatchObject({ personalHints: [{ text: "Jane Doe", kind: "name" }], keepPersonal: ["Wechsler Scale"] });
  });
});

describe("a type that does not parse", () => {
  it("opens the editor in JSON with the draft, and the fixed type clears the block on Save", () => {
    const d = draft();
    const broken = { ...d.type, key: "lab-request", sections: [{ ...d.type.sections[0], guidance: undefined }] };
    const bad: LearnDraft = { ...d, type: broken as unknown as LearnDraft["type"], validation: { ...d.validation, type: ["sections.0.guidance: Required"] } };
    let s = { ...initialReview(bad), reviewed: true };
    expect(saveBlocker(s, bad)).toBe("Fix the problems listed before saving.");
    const start = typeEditorStart(s.draft.type);
    expect(start.typeOk).toBe(false);
    // The author fixes the JSON the editor opened with; TypeEditor hands back the parsed text.
    const fixed = JSON.parse(start.initialJson!);
    fixed.sections[0].guidance = "Say what is needed.";
    const r = parseDefinition(fixed);
    expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
    if (!r.ok) return;
    s = { ...applyTypeEdit(s, r.definition), reviewed: true };
    expect(saveBlocker(s, bad)).toBeNull();
    expect(typeEditorStart(s.draft.type)).toEqual({ typeOk: true });
  });
});
