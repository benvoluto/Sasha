// step.decide: one of the outcome's fixed values (a zod enum of config.values),
// chosen from the findings, agreements, disagreements, computed results and
// scores, with a rationale citing the finding ids it rests on. Advisory until
// a checkpoint signs it.
//
// With `categories` (an FIE) it decides per category instead: each category's
// result is worked out in code from the agreement on its criteria, the model
// judges only whether a met category shows a need for services, and the value
// follows from the categories (DecideCategories in node-specs/steps.ts). The
// per-category results go out as a table for the outcome.

import { z } from "zod";
import { requirementSet } from "@/catalog/workflows";
import { claudeJson } from "@/lib/llm/claude";
import type { AgreedItem, CheckResult, ComputeResult, Disagreement, EvidenceLink, Finding, OutcomeTable, ScoreSummary } from "../contract";
import { NodeError, type NodeHandler } from "../context";
import type { DecideCategories } from "../node-specs/steps";
import { CATEGORY_DECIDE_SYSTEM, DECIDE_SYSTEM, defuseAll, tagBlock } from "./prompts";
import { snakeKey } from "./review";
import { callOpts, clip, flat, outcomeTable } from "./util";

export type DecideConfig = { values: string[]; guidance: string; categories?: DecideCategories | null };
export type DecideMaterial = { findings: Finding[]; agreed: AgreedItem[]; disagreements: Disagreement[]; results: Array<ComputeResult | CheckResult>; scores: ScoreSummary[] };

export const decideSchema = (values: string[]) => z.object({ value: z.enum(values as [string, ...string[]]), rationale: z.string(), cited: z.array(z.string()) });
export type DecideReply = { value: string; rationale: string; cited: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function decideMaterial(inputs: Record<string, unknown>): DecideMaterial {
  return {
    findings: flat<Finding>(inputs.findings).filter((f) => isObj(f) && typeof f.id === "string" && typeof f.severity === "string"),
    agreed: flat<AgreedItem>(inputs.agreed).filter((a) => isObj(a) && Array.isArray(a.positions)),
    disagreements: flat<Disagreement>(inputs.disagreements).filter((d) => isObj(d) && Array.isArray(d.positions)),
    results: flat<ComputeResult | CheckResult>(inputs.results).filter(isObj),
    scores: flat<ScoreSummary>(inputs.scores).filter((s) => isObj(s) && typeof s.median === "number"),
  };
}

const pos = (p: { label: string; verdict: string | null; score: number | null; rationale: string }) => `${p.label}: ${p.verdict ?? (p.score !== null ? `score ${p.score}` : "no rating")}. ${clip(p.rationale, 600)}`;

export function decideUserPrompt(config: DecideConfig, m: DecideMaterial): string {
  const out: string[] = [];
  out.push(`Allowed values: ${config.values.join(" | ")}`);
  out.push(`Guidance: ${config.guidance}`);
  const findings = m.findings.map((f) => tagBlock("item", defuseAll(`[${f.severity}] ${f.title}${f.status ? ` (${f.status})` : ""}\n${clip(f.detail, 800)}${f.verified ? "" : "\n(unverified)"}`), { id: f.id }));
  out.push(tagBlock("items", findings.join("\n") || "(no findings)", { role: "findings" }));
  const results = m.results.map((r) =>
    "check" in r
      ? `- ${r.label}${r.itemId ? ` (${r.itemId})` : ""}: ${r.status}. ${clip(r.rationale, 400)}`
      : `- ${r.label}: ${r.ok === null ? "could not compute" : r.ok ? "ok" : "failed"}; expected ${r.expected}, actual ${r.actual}${r.approximate ? " (estimate)" : ""}. ${clip(r.detail, 300)}`,
  );
  if (results.length) out.push(tagBlock("data", defuseAll(results.join("\n")), { role: "results" }));
  const reviews: string[] = [];
  for (const a of m.agreed) reviews.push(tagBlock("review", defuseAll(`Agreed${a.verdict ? `: ${a.verdict}` : ""}\n${a.positions.map(pos).join("\n")}`), { item: a.item, label: a.label }));
  for (const d of m.disagreements) reviews.push(tagBlock("review", defuseAll(`Disagreed${d.blocking ? " (blocking)" : ""}\n${d.positions.map(pos).join("\n")}`), { id: d.id, item: d.item, label: d.label }));
  for (const s of m.scores) reviews.push(tagBlock("review", defuseAll(`Scores: median ${s.median}, range ${s.min}–${s.max}${s.meanTimes10 !== null ? `, mean × 10 ${s.meanTimes10}` : ""}`), { item: s.item, label: s.label }));
  if (reviews.length) out.push(tagBlock("reviews", reviews.join("\n")));
  return out.join("\n\n");
}

/** Pure: the value and the rationale, with the cited finding and disagreement ids that exist appended (unknown ones dropped). */
export function buildDecision(reply: DecideReply, config: DecideConfig, m: DecideMaterial): { value: string; rationale: string } {
  if (!config.values.includes(reply.value)) throw new Error("the decision step returned an unknown value");
  const known = new Set([...m.findings.map((f) => f.id), ...m.disagreements.map((d) => d.id)]);
  const cited = [...new Set(reply.cited.map((c) => c.trim()).filter((c) => known.has(c)))];
  const rationale = clip(reply.rationale.trim(), 4000);
  return { value: reply.value, rationale: cited.length ? `${rationale}\n\nRests on: ${cited.join(", ")}.` : rationale };
}

// --- By category ---------------------------------------------------------------------------

export type CategoryState = "met" | "not_met" | "insufficient" | "disputed";
export type CategoryResult = { category: string; result: CategoryState; criteria: Array<{ item: string; label: string; state: string }>; evidence: EvidenceLink[] };
export const NEEDS = ["needs_services", "no_need", "unclear"] as const;
export type Need = (typeof NEEDS)[number];

const NOT_RATED = "not rated";

/**
 * Pure: each rated category's result from the agreement on its criteria. A
 * category none of whose criteria any reviewer rated is not suspected and is
 * left out. Any criterion agreed not met → not_met; every criterion agreed met
 * → met; else disputed when reviewers disagree on one, otherwise insufficient
 * (agreed short of evidence, or a criterion left unrated).
 */
export function categoryResults(cfg: DecideCategories, m: Pick<DecideMaterial, "agreed" | "disagreements">): CategoryResult[] {
  const set = requirementSet(cfg.from);
  if (!set) throw new NodeError(`unknown requirement set “${cfg.from}”`);
  const agreed = new Map(m.agreed.map((a) => [a.item, a]));
  const disputed = new Map(m.disagreements.map((d) => [d.item, d]));
  const byCategory = new Map<string, Array<{ key: string; label: string }>>();
  for (const i of set.items) {
    if (i.kind !== "criterion") continue;
    for (const c of i.appliesTo?.categories?.length ? i.appliesTo.categories : [i.title]) byCategory.set(c, [...(byCategory.get(c) ?? []), { key: snakeKey(i.key), label: i.title }]);
  }
  const out: CategoryResult[] = [];
  for (const [category, crits] of byCategory) {
    const criteria = crits.map((c) => {
      const a = agreed.get(c.key);
      const d = disputed.get(c.key);
      return { item: c.key, label: c.label, state: a ? (a.verdict ?? "agreed") : d ? "disputed" : NOT_RATED, evidence: (a?.positions ?? d?.positions ?? []).flatMap((p) => p.evidence) };
    });
    if (criteria.every((c) => c.state === NOT_RATED)) continue;
    const result: CategoryState = criteria.some((c) => c.state === cfg.notMetVerdict)
      ? "not_met"
      : criteria.every((c) => c.state === cfg.metVerdict)
        ? "met"
        : criteria.some((c) => c.state === "disputed")
          ? "disputed"
          : "insufficient";
    out.push({ category, result, criteria: criteria.map(({ item, label, state }) => ({ item, label, state })), evidence: criteria.flatMap((c) => c.evidence) });
  }
  return out;
}

/** Pure: the overall value from the category results and the needs judged for the met ones. */
export function categoryValue(cfg: DecideCategories, results: CategoryResult[], needs: Map<string, Need>): string {
  const met = results.filter((r) => r.result === "met");
  if (met.some((r) => needs.get(r.category) === "needs_services")) return cfg.met;
  if (results.some((r) => r.result === "disputed" || r.result === "insufficient") || met.some((r) => needs.get(r.category) !== "no_need")) return cfg.insufficient;
  if (met.length) return cfg.metNoNeed;
  return results.length ? cfg.notMet : cfg.insufficient;
}

const RESULT_LABEL: Record<CategoryState, string> = { met: "Criteria met", not_met: "Criteria not met", insufficient: "Insufficient evidence", disputed: "Insufficient evidence (reviewers disagree)" };
const NEED_LABEL: Record<Need, string> = { needs_services: "Needs special education and related services", no_need: "No demonstrated need", unclear: "Need not shown either way" };

export function categoryTable(nodeId: string, results: CategoryResult[], needs: Map<string, Need>, why: Map<string, string>): OutcomeTable {
  return outcomeTable(
    `${nodeId}-categories`,
    "Result by category",
    [
      { key: "category", label: "Category" },
      { key: "result", label: "Criteria" },
      { key: "need", label: "Need for services" },
      { key: "criteria", label: "Criteria as agreed" },
      { key: "why", label: "Basis for need" },
    ],
    results.map((r) => {
      const need = r.result === "met" ? needs.get(r.category) ?? "unclear" : null;
      return {
        cells: {
          category: r.category,
          result: RESULT_LABEL[r.result],
          need: need ? NEED_LABEL[need] : "",
          criteria: r.criteria.map((c) => `${c.label}: ${c.state.replace(/_/g, " ")}`).join("; "),
          why: need ? clip(why.get(r.category) ?? "", 1000) : "",
        },
        status: r.result,
        evidence: r.evidence,
      };
    }),
  );
}

export const categoryDecideSchema = z.object({
  needs: z.array(z.object({ category: z.string(), need: z.enum(NEEDS), rationale: z.string() })),
  rationale: z.string(),
  cited: z.array(z.string()),
});
export type CategoryDecideReply = z.infer<typeof categoryDecideSchema>;

export function categoryUserPrompt(config: DecideConfig, m: DecideMaterial, results: CategoryResult[]): string {
  const rows = results.map((r) => tagBlock("category", defuseAll(`${RESULT_LABEL[r.result]}\n${r.criteria.map((c) => `- ${c.label}: ${c.state.replace(/_/g, " ")}`).join("\n")}`), { name: r.category }));
  const met = results.filter((r) => r.result === "met").map((r) => r.category);
  return [
    decideUserPrompt({ ...config, values: [] }, m).replace(/^Allowed values: .*\n\n/, ""),
    tagBlock("categories", rows.join("\n") || "(no category was rated)", { role: "results worked out from the agreement" }),
    met.length ? `Judge need for: ${met.join(" | ")}` : "No category's criteria are met: give an empty needs list.",
  ].join("\n\n");
}

/** Pure: the per-category decision. Needs for categories that are not met (or unknown) are dropped. */
export function buildCategoryDecision(reply: CategoryDecideReply, cfg: DecideCategories, m: DecideMaterial, results: CategoryResult[], nodeId: string): { value: string; rationale: string; table: OutcomeTable } {
  const met = new Set(results.filter((r) => r.result === "met").map((r) => r.category.toLowerCase()));
  const canon = new Map(results.map((r) => [r.category.toLowerCase(), r.category]));
  const needs = new Map<string, Need>();
  const why = new Map<string, string>();
  for (const n of reply.needs) {
    const key = n.category.trim().toLowerCase();
    if (!met.has(key) || needs.has(canon.get(key)!)) continue;
    needs.set(canon.get(key)!, n.need);
    why.set(canon.get(key)!, n.rationale.trim());
  }
  const { rationale } = buildDecision({ value: cfg.insufficient, rationale: reply.rationale, cited: reply.cited }, { values: [cfg.insufficient], guidance: "" }, m);
  return { value: categoryValue(cfg, results, needs), rationale, table: categoryTable(nodeId, results, needs, why) };
}

export const stepDecide: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as DecideConfig;
  const m = decideMaterial(inputs);
  if (config.categories) {
    const results = categoryResults(config.categories, m);
    const { data } = await claudeJson({ task: "workflow.decide", system: CATEGORY_DECIDE_SYSTEM, user: categoryUserPrompt(config, m, results), schema: categoryDecideSchema, ...callOpts(ctx) });
    return buildCategoryDecision(data as CategoryDecideReply, config.categories, m, results, node.node.id);
  }
  const { data } = await claudeJson({ task: "workflow.decide", system: DECIDE_SYSTEM, user: decideUserPrompt(config, m), schema: decideSchema(config.values), ...callOpts(ctx) });
  return buildDecision(data as DecideReply, config, m);
};
