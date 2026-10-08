// step.review: two or three independent reviewers, one model call each, run in
// parallel. Every call gets the same material and only its own brief; none
// sees another reviewer's output. With `discuss` (the disagreements from
// step.agree) it is the second round: each reviewer sees the others' round-1
// positions on the disputed items only, responds once and rescores them.

import { z } from "zod";
import { requirementSet } from "@/catalog/workflows";
import { claudeJson } from "@/lib/llm/claude";
import type { Disagreement, ExtractedItem, Finding, Rating, Review, ReviewNote } from "../contract";
import { NodeError, type NodeHandler } from "../context";
import type { CriterionSpec, ReviewConfig, ReviewerSpec, Scale } from "../node-specs/steps";
import { DISCUSS_RULES, REVIEW_SYSTEM, defuseAll, documentBlock, itemsBlock, requirementsBlock, sourcesBlock, tagBlock } from "./prompts";
import { asDoc, asItems, asRequirements, asSources, callOpts, clip, EvidenceIndex, fieldText, Findings, flat, itemName } from "./util";
import type { DocSnapshot, RequirementsView, SourcesSnapshot } from "./types";

const DEFAULT_CRITERION_SCALE: Scale = { kind: "enum", values: ["met", "not_met", "insufficient_evidence"] };
const DEFAULT_MATRIX_SCALE: Scale = { kind: "enum", values: ["strong", "adequate", "weak", "unknown"] };

/** snake_case key from any id or title. */
export const snakeKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(?=[0-9])/, "k_")
    .slice(0, 60) || "item";

/** Pure: one criterion per requirement item of kind "criterion" in the set. */
export function criteriaFromSet(setKey: string, scale: Scale = DEFAULT_CRITERION_SCALE): CriterionSpec[] {
  const set = requirementSet(setKey);
  if (!set) throw new NodeError(`unknown requirement set “${setKey}”`);
  return set.items.filter((i) => i.kind === "criterion").map((i) => ({ key: snakeKey(i.key), label: clip(i.title, 200), guidance: clip([i.text, i.citation ? `(${i.citation})` : ""].filter(Boolean).join(" "), 2000), scale }));
}

/** Pure: one cell per option × criterion, from items whose `kind` field is "option" or "criterion". Keys "<option_id>__<criterion_id>". */
export function matrixCriteria(items: ExtractedItem[], scale: Scale = DEFAULT_MATRIX_SCALE): CriterionSpec[] {
  const idOf = (it: ExtractedItem) => snakeKey(fieldText(it.fields.id) || it.id);
  const nameOf = (it: ExtractedItem) => fieldText(it.fields.name) || itemName(it);
  const options = items.filter((i) => fieldText(i.fields.kind).toLowerCase() === "option");
  const criteria = items.filter((i) => fieldText(i.fields.kind).toLowerCase() === "criterion");
  return options.flatMap((o) =>
    criteria.map((c) => ({
      key: `${idOf(o)}__${idOf(c)}`.slice(0, 60),
      label: clip(`${nameOf(o)} × ${nameOf(c)}`, 200),
      guidance: clip(fieldText(c.fields.description), 2000),
      scale,
    })),
  );
}

/** Pure: the criteria a review rates: `criteria`, then `criteriaFrom`, then the matrix cells. */
export function buildCriteria(config: ReviewConfig, items: ExtractedItem[]): CriterionSpec[] {
  const out = [...config.criteria];
  if (config.criteriaFrom) out.push(...criteriaFromSet(config.criteriaFrom, config.criterionScale));
  if (config.matrix) out.push(...matrixCriteria(items, config.criterionScale));
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.key) && !!seen.add(c.key));
}

/** Pure: criteria for disputed items a round-2 review has no spec for (a matrix without its items): the scale the positions used. */
export function criterionForDispute(d: Disagreement): CriterionSpec {
  const scores = d.positions.map((p) => p.score).filter((s): s is number => s !== null);
  const verdicts = [...new Set(d.positions.map((p) => p.verdict).filter((v): v is string => !!v))];
  const scale: Scale = scores.length ? { kind: "score", min: Math.min(...scores), max: Math.max(...scores), best: "low" } : { kind: "enum", values: verdicts.length >= 2 ? verdicts : [...verdicts, "insufficient_evidence"] };
  return { key: d.item, label: d.label, guidance: "", scale };
}

const scaleText = (s: Scale) => (s.kind === "enum" ? `one of ${s.values.join(" | ")}` : `an integer score ${s.min}–${s.max} (${s.best === "low" ? s.min : s.max} is best)`);

export const ReviewModelOutput = z.object({
  ratings: z.array(z.object({ item: z.string(), verdict: z.string().nullable(), score: z.number().nullable(), rationale: z.string(), evidence: z.array(z.object({ id: z.string(), quote: z.string() })) })),
  strengths: z.array(z.object({ text: z.string(), evidence: z.array(z.object({ id: z.string(), quote: z.string() })) })),
  weaknesses: z.array(z.object({ text: z.string(), evidence: z.array(z.object({ id: z.string(), quote: z.string() })) })),
});
export type ReviewModelOutput = z.infer<typeof ReviewModelOutput>;

/** Pure: a reviewer's system prompt (stable per brief): the shared rules, then the brief. */
export function reviewSystem(r: ReviewerSpec): string {
  return `${REVIEW_SYSTEM}\n\n${tagBlock("brief", defuseAll(r.brief), { reviewer: r.label })}`;
}

export type ReviewMaterial = { doc: DocSnapshot | null; sources: SourcesSnapshot | null; items: ExtractedItem[]; requirements: RequirementsView | null };

/** Pure: the user message every reviewer of a round gets (identical across reviewers in round 1). */
export function reviewUserPrompt(config: ReviewConfig, criteria: CriterionSpec[], m: ReviewMaterial, discuss?: { reviewer: string; disputes: Disagreement[] }): string {
  const out: string[] = [];
  out.push(["Criteria (key: label; scale; guidance):", ...criteria.map((c) => `- ${c.key}: ${c.label}; ${scaleText(c.scale)}${c.guidance ? `; ${c.guidance}` : ""}`)].join("\n"));
  if (config.instructions.trim()) out.push(`Instructions: ${config.instructions.trim()}`);
  out.push(discuss ? "Give no strengths or weaknesses this round (empty lists)." : config.strengthsAndWeaknesses ? "Also list the main strengths and weaknesses, each with its evidence, the weaknesses most likely to drive your ratings first." : "Give no strengths or weaknesses (empty lists).");
  if (m.doc) out.push(documentBlock(m.doc));
  if (m.sources) out.push(sourcesBlock(m.sources));
  if (m.items.length && !config.matrix) out.push(itemsBlock(m.items));
  if (m.items.length && config.matrix) out.push(itemsBlock(m.items, { role: "options and criteria" }));
  if (m.requirements) out.push(requirementsBlock(m.requirements));
  if (discuss) {
    out.push(DISCUSS_RULES);
    out.push(discussBlock(discuss.reviewer, discuss.disputes));
  }
  return out.join("\n\n");
}

/** Pure: the other reviewers' positions on the disputed items (never the reader's own, never undisputed items). */
export function discussBlock(reviewer: string, disputes: Disagreement[]): string {
  const parts = disputes.map((d) => {
    const others = d.positions.filter((p) => p.reviewer !== reviewer);
    const lines = others.map((p) =>
      tagBlock("position", defuseAll([`${p.label}: ${p.verdict ?? (p.score !== null ? `score ${p.score}` : "no rating")}`, p.rationale, p.evidence.length ? `Evidence: ${p.evidence.map((e) => `${e.ref}${e.quote ? ` "${clip(e.quote, 300)}"` : ""}`).join("; ")}` : ""].filter(Boolean).join("\n")), { reviewer: p.reviewer }),
    );
    const own = d.positions.find((p) => p.reviewer === reviewer);
    const mine = own ? `Your round-1 position: ${own.verdict ?? (own.score !== null ? `score ${own.score}` : "no rating")}` : "You did not rate this item in round 1.";
    return tagBlock("review", `${defuseAll(mine)}\n${lines.join("\n")}`, { item: d.item, label: d.label });
  });
  return tagBlock("reviews", parts.join("\n"));
}

function validRating(c: CriterionSpec, r: ReviewModelOutput["ratings"][number]): { verdict: string | null; score: number | null } | null {
  if (c.scale.kind === "enum") return r.verdict && c.scale.values.includes(r.verdict) ? { verdict: r.verdict, score: null } : null;
  if (r.score === null || !Number.isFinite(r.score)) return null;
  const score = Math.round(r.score);
  return score >= c.scale.min && score <= c.scale.max ? { verdict: null, score } : null;
}

/** Pure: a reviewer's reply as a Review. Ratings for unknown items or off-scale values are dropped; unknown ids in evidence are dropped. */
export function buildReview(r: ReviewerSpec, reply: ReviewModelOutput, criteria: CriterionSpec[], index: EvidenceIndex, round: 1 | 2): Review {
  // A rating names its criterion by key, or (as models sometimes do) by its exact label.
  const byKey = new Map(criteria.flatMap((c) => [[c.key.toLowerCase(), c], [c.label.toLowerCase(), c]] as Array<[string, CriterionSpec]>));
  const ratings: Rating[] = [];
  for (const x of reply.ratings) {
    const c = byKey.get(x.item.trim().toLowerCase());
    const v = c && validRating(c, x);
    if (!c || !v || ratings.some((y) => y.item === c.key)) continue;
    const evidence = index.links(x.evidence);
    const rationale = x.evidence.length && !evidence.length ? `${x.rationale} (Its cited support could not be found in the material.)` : x.rationale;
    ratings.push({ item: c.key, ...v, rationale: clip(rationale, 2000), evidence });
  }
  const notes = (list: ReviewModelOutput["strengths"]): ReviewNote[] => (round === 2 ? [] : list.map((n) => ({ text: clip(n.text, 1000), evidence: index.links(n.evidence) })));
  return { reviewer: r.key, label: r.label, brief: r.brief, ratings, strengths: notes(reply.strengths), weaknesses: notes(reply.weaknesses), round };
}

/**
 * Pure: weaknesses as major findings (kind weakness), with the reviewer set,
 * the ones most likely to drive the score first (an outcome keeping only the
 * top few keeps those). Each reviewer lists theirs in that order, so they are
 * taken round-robin: every reviewer's first, then every second. A weakness
 * citing only passages that another reviewer's earlier weakness already cites
 * is the same point raised again: it moves to the end, and the earlier one
 * names who else raised it and ranks above those only one reviewer raised.
 */
export function reviewFindings(nodeId: string, reviews: Review[]): Finding[] {
  type W = { r: Review; w: ReviewNote; rank: number; also: string[] };
  const order = reviews
    .flatMap((r) => r.weaknesses.map((w, rank): W => ({ r, w, rank, also: [] })))
    .map((x, i) => ({ x, i }))
    .sort((a, b) => a.x.rank - b.x.rank || a.i - b.i)
    .map(({ x }) => x);
  const lead: W[] = [];
  const repeats: W[] = [];
  for (const x of order) {
    const refs = x.w.evidence.map((e) => e.ref);
    const same = refs.length ? lead.find((y) => y.r.reviewer !== x.r.reviewer && refs.every((ref) => y.w.evidence.some((e) => e.ref === ref))) : undefined;
    if (!same) {
      lead.push(x);
      continue;
    }
    if (!same.also.includes(x.r.label)) same.also.push(x.r.label);
    repeats.push(x);
  }
  const ranked = lead.map((x, i) => ({ x, i })).sort((a, b) => b.x.also.length - a.x.also.length || a.i - b.i).map(({ x }) => x);
  const f = new Findings(nodeId);
  for (const { r, w, also } of [...ranked, ...repeats])
    f.add({ kind: "weakness", severity: "major", title: clip(w.text, 300), detail: also.length ? `${w.text}\n\nAlso raised by: ${also.join(", ")}.` : w.text, evidence: w.evidence, reviewer: r.reviewer, location: null });
  return f.list();
}

export const stepReview: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as ReviewConfig;
  const m: ReviewMaterial = { doc: asDoc(inputs.document), sources: asSources(inputs.sources), items: asItems(inputs.items), requirements: asRequirements(inputs.requirements) };
  // A wired "discuss" that delivered nothing (its branch was not taken) is a discussion with nothing to discuss, not a fresh round-1 review.
  const discussWired = ctx.run.graph.edges.some((e) => e.target === node.node.id && e.targetHandle === "discuss");
  const disputes = inputs.discuss === undefined ? (discussWired ? [] : null) : flat<Disagreement>(inputs.discuss).filter((d) => d && typeof d.item === "string" && Array.isArray(d.positions));
  if (disputes && !disputes.length) return { reviews: [], findings: [] };
  let criteria = buildCriteria(config, m.items);
  if (disputes) {
    const known = new Map(criteria.map((c) => [c.key, c]));
    criteria = disputes.map((d) => known.get(d.item) ?? criterionForDispute(d));
  }
  if (!criteria.length) throw new NodeError(config.matrix ? "the matrix needs items with kind “option” and “criterion”" : "nothing to rate: no criteria");
  const index = new EvidenceIndex({ doc: m.doc, sources: m.sources, items: m.items.map((i) => [i.id, i] as [string, ExtractedItem]), requirements: m.requirements });
  const round = disputes ? 2 : 1;
  const reviews = await Promise.all(
    config.reviewers.map(async (r) => {
      const { data } = await claudeJson({
        task: "workflow.review",
        system: reviewSystem(r),
        user: reviewUserPrompt(config, criteria, m, disputes ? { reviewer: r.key, disputes } : undefined),
        schema: ReviewModelOutput,
        ...callOpts(ctx),
      });
      return buildReview(r, data, criteria, index, round);
    }),
  );
  return { reviews, findings: reviewFindings(node.node.id, reviews) };
};
