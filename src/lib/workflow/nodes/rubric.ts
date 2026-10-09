// rubric.score: the document (or, with scope "drafted", the drafted sections)
// scored against the type's rubric plus the universal writing rubric
// (rubricFor), one level per criterion with document quotes and a fix. Levels
// 1 and 2 become findings.

import { buildScores, rubricCriteria, RubricModelOutput, rubricUserPrompt, scoreRubric } from "@/lib/rubric/check";
import type { DraftedSection, Finding } from "../contract";
import { NodeError, type NodeHandler } from "../context";
import { asDoc, callOpts, type EvidenceIndex, Findings, flat, outcomeTable } from "./util";
import type { DocSnapshot, RubricScore } from "./types";

// The scorer lives in src/lib/rubric/check.ts (shared with the editor's check);
// re-exported for the live cases and tests that import it from here.
export { buildScores, rubricCriteria, RubricModelOutput, rubricUserPrompt };

export type RubricConfig = { scope: "document" | "drafted"; criteria: string[] };

/** Pure: the drafts as section-text replacements, keyed by the snapshot's section id (matched by sectionId, then specKey). */
export function draftTexts(d: DocSnapshot, drafts: DraftedSection[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const dr of drafts) {
    const s = d.sections.find((x) => x.sectionId === dr.sectionId) ?? (dr.specKey ? d.sections.find((x) => x.specKey === dr.specKey) : undefined);
    if (s && dr.markdown.trim()) out.set(s.sectionId, dr.markdown);
  }
  return out;
}

/** Level 1 is a major finding, level 2 minor (kind rubric). */
export function rubricFindings(nodeId: string, scores: RubricScore[], index: EvidenceIndex): Finding[] {
  const f = new Findings(nodeId);
  for (const s of scores) {
    if (s.level > 2) continue;
    const at = s.evidence.find((e) => e.kind === "document");
    f.add({ kind: "rubric", severity: s.level <= 1 ? "major" : "minor", status: `level_${s.level}`, title: `${s.label} (${s.level} of ${s.maxLevel})`, detail: s.rationale, location: at ? index.location(at.ref, at.quote) : null, evidence: s.evidence, fix: s.fix });
  }
  return f.list();
}

export function rubricTable(nodeId: string, scores: RubricScore[]) {
  return outcomeTable(
    nodeId,
    "Rubric",
    [
      { key: "criterion", label: "Criterion" },
      { key: "level", label: "Level" },
      { key: "why", label: "Why" },
      { key: "fix", label: "Fix" },
    ],
    scores.map((s) => ({ cells: { criterion: s.label, level: `${s.level} / ${s.maxLevel}`, why: s.rationale, fix: s.fix }, status: `level_${s.level}`, evidence: s.evidence })),
  );
}

export const rubricScore: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as RubricConfig;
  const d = asDoc(inputs.document);
  if (!d) throw new NodeError("rubric scoring needs the document");
  const id = node.node.id;
  let drafted: Map<string, string> | null = null;
  if (config.scope === "drafted") {
    drafted = draftTexts(d, flat<DraftedSection>(inputs.drafts).filter((x) => x && typeof x.markdown === "string"));
    if (!drafted.size) return { scores: [], findings: [], table: rubricTable(id, []) };
  }
  const criteria = rubricCriteria(d, config.criteria);
  if (!criteria.length) return { scores: [], findings: [], table: rubricTable(id, []) };
  const { scores, index } = await scoreRubric(d, { criteria, drafted, call: callOpts(ctx) });
  return { scores, findings: rubricFindings(id, scores, index), table: rubricTable(id, scores) };
};
