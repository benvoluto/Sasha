// rubric.score: the document (or, with scope "drafted", the drafted sections)
// scored against the type's rubric plus the universal writing rubric
// (rubricFor), one level per criterion with document quotes and a fix. Levels
// 1 and 2 become findings.

import { z } from "zod";
import { rubricFor } from "@/catalog";
import type { RubricCriterion } from "@/catalog/schema";
import { claudeJson } from "@/lib/llm/claude";
import type { DraftedSection, Finding } from "../contract";
import { NodeError, type NodeHandler } from "../context";
import { RUBRIC_SYSTEM, documentBlock } from "./prompts";
import { asDoc, callOpts, clip, EvidenceIndex, Findings, flat, outcomeTable } from "./util";
import type { DocSnapshot, RubricScore } from "./types";

export type RubricConfig = { scope: "document" | "drafted"; criteria: string[] };

/** Pure: the criteria to score: the type's full rubric (universal criteria when untyped), narrowed to `only` when given. */
export function rubricCriteria(d: DocSnapshot, only: string[]): RubricCriterion[] {
  const all = d.type?.rubric ?? rubricFor({ rubric: [] });
  return only.length ? all.filter((c) => only.includes(c.key)) : all;
}

export const RubricModelOutput = z.object({
  scores: z.array(z.object({ criterion: z.string(), level: z.number(), rationale: z.string(), evidence: z.array(z.object({ id: z.string(), quote: z.string() })), fix: z.string() })),
});
export type RubricModelOutput = z.infer<typeof RubricModelOutput>;

/** Pure: the drafts as section-text replacements, keyed by the snapshot's section id (matched by sectionId, then specKey). */
export function draftTexts(d: DocSnapshot, drafts: DraftedSection[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const dr of drafts) {
    const s = d.sections.find((x) => x.sectionId === dr.sectionId) ?? (dr.specKey ? d.sections.find((x) => x.specKey === dr.specKey) : undefined);
    if (s && dr.markdown.trim()) out.set(s.sectionId, dr.markdown);
  }
  return out;
}

export function rubricUserPrompt(d: DocSnapshot, criteria: RubricCriterion[], drafted: Map<string, string> | null): string {
  const out: string[] = [];
  const crit = criteria.map((c) => [`Criterion ${c.key}: ${c.criterion}${c.appliesTo ? ` (sections: ${c.appliesTo.join(", ")})` : ""}`, ...[...c.levels].sort((a, b) => b.score - a.score).map((l) => `  ${l.score}: ${l.descriptor}`)].join("\n"));
  out.push(["Rubric:", ...crit].join("\n"));
  if (drafted) out.push("Score only the drafted sections below (new drafts placed in the document).");
  out.push(documentBlock(d, drafted ? { replace: drafted, onlyReplaced: true } : {}));
  return out.join("\n\n");
}

/** Pure: one score per criterion scored. Unknown criteria are dropped, levels clamped to the criterion's range, unknown ids dropped. */
export function buildScores(reply: RubricModelOutput, criteria: RubricCriterion[], index: EvidenceIndex): RubricScore[] {
  const byKey = new Map(criteria.map((c) => [c.key, c]));
  const out: RubricScore[] = [];
  for (const r of reply.scores) {
    const c = byKey.get(r.criterion.trim());
    if (!c || out.some((o) => o.criterion === c.key)) continue;
    const levels = c.levels.map((l) => l.score);
    const level = Math.min(Math.max(Math.round(r.level), Math.min(...levels)), Math.max(...levels));
    out.push({ criterion: c.key, label: clip(c.criterion, 300), level, maxLevel: Math.max(...levels), rationale: clip(r.rationale, 2000), evidence: index.links(r.evidence), fix: clip(r.fix, 1000) });
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
  const raw = asDoc(inputs.document);
  if (!raw) throw new NodeError("rubric scoring needs the document");
  const id = node.node.id;
  let drafted: Map<string, string> | null = null;
  let d = raw;
  if (config.scope === "drafted") {
    drafted = draftTexts(raw, flat<DraftedSection>(inputs.drafts).filter((x) => x && typeof x.markdown === "string"));
    if (!drafted.size) return { scores: [], findings: [], table: rubricTable(id, []) };
    // Quotes are checked against the drafts, not the empty sections they fill.
    d = { ...raw, sections: raw.sections.map((s) => (drafted!.has(s.sectionId) ? { ...s, text: drafted!.get(s.sectionId)! } : s)) };
  }
  const criteria = rubricCriteria(d, config.criteria);
  if (!criteria.length) return { scores: [], findings: [], table: rubricTable(id, []) };
  const index = new EvidenceIndex({ doc: d });
  const { data } = await claudeJson({ task: "rubric.check", system: RUBRIC_SYSTEM, user: rubricUserPrompt(d, criteria, drafted), schema: RubricModelOutput, ...callOpts(ctx) });
  const scores = buildScores(data, criteria, index);
  return { scores, findings: rubricFindings(id, scores, index), table: rubricTable(id, scores) };
};
