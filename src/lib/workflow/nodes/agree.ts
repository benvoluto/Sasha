// step.agree: the reviewers compared item by item, in code. Agreements carry
// forward; each disagreement keeps every reviewer's position and rationale.
// Nothing is averaged into a resolution: score items report the median, range
// and (for NIH) the mean × 10 beside the positions, never in place of them. A
// reviewer's round-2 rating replaces their round-1 rating for that item. An
// item counts as agreed only when every reviewer rated it the same way: a
// reviewer who left it out is a "not rated" position, so one reviewer's rating
// is never agreement.

import type { AgreedItem, Disagreement, Finding, Rating, Review, ReviewerPosition, ScoreSummary } from "../contract";
import type { NodeHandler } from "../context";
import { Findings, flat, outcomeTable } from "./util";

export type AgreeConfig = { mode: "verdict" | "score"; tolerance: number; blockingVerdicts: string[]; meanTimes10: boolean };

export type AgreeResult = { agreed: AgreedItem[]; disagreements: Disagreement[]; scores: ScoreSummary[]; findings: Finding[] };

/** Pure: each reviewer's latest rating per item (round 2 over round 1), items in first-seen order. */
export function latestRatings(reviews: Review[]): { items: string[]; byReviewer: Map<string, { review: Review; ratings: Map<string, Rating> }> } {
  const items: string[] = [];
  const byReviewer = new Map<string, { review: Review; ratings: Map<string, Rating> }>();
  for (const review of [...reviews].sort((a, b) => a.round - b.round)) {
    const entry = byReviewer.get(review.reviewer) ?? { review, ratings: new Map<string, Rating>() };
    if (review.round >= entry.review.round) entry.review = { ...entry.review, round: review.round };
    for (const r of review.ratings) {
      if (!items.includes(r.item)) items.push(r.item);
      entry.ratings.set(r.item, r);
    }
    byReviewer.set(review.reviewer, entry);
  }
  return { items, byReviewer };
}

/** The rationale of a reviewer who left an item out. */
export const NOT_RATED = "Did not rate this item.";

/** "factor_1" → "Factor 1"; matrix cells "opt__crit" → "opt × crit". */
export const humanize = (key: string) => {
  const t = key.replace(/__/g, " × ").replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: the agreement over all reviews given (round 1 and 2, flattened). */
export function agree(nodeId: string, reviews: Review[], config: AgreeConfig, labels: Map<string, string> = new Map()): AgreeResult {
  const { items, byReviewer } = latestRatings(reviews);
  const agreed: AgreedItem[] = [];
  const disagreements: Disagreement[] = [];
  const scores: ScoreSummary[] = [];
  const f = new Findings(nodeId);
  const blocking = new Set(config.blockingVerdicts);
  for (const item of items) {
    const positions: ReviewerPosition[] = [];
    for (const { review, ratings } of byReviewer.values()) {
      const r = ratings.get(item);
      if (r) positions.push({ reviewer: review.reviewer, label: review.label, brief: review.brief, verdict: r.verdict, score: r.score, rationale: r.rationale, evidence: r.evidence });
    }
    if (!positions.length) continue;
    const unrated: ReviewerPosition[] = [...byReviewer.values()]
      .filter(({ ratings }) => !ratings.has(item))
      .map(({ review }) => ({ reviewer: review.reviewer, label: review.label, brief: review.brief, verdict: null, score: null, rationale: NOT_RATED, evidence: [] }));
    const label = labels.get(item) ?? humanize(item);
    const numeric = positions.every((p) => p.score !== null);
    let differ: boolean;
    if (numeric) {
      const xs = positions.map((p) => p.score!);
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      scores.push({ item, label, median: median(xs), min: lo, max: hi, meanTimes10: config.meanTimes10 ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) : null, nodeId });
      differ = config.mode === "score" ? hi - lo >= config.tolerance : new Set(xs).size > 1;
    } else {
      differ = new Set(positions.map((p) => p.verdict ?? (p.score === null ? "" : String(p.score)))).size > 1;
    }
    const blockers = positions.filter((p) => p.verdict !== null && blocking.has(p.verdict));
    if (differ || unrated.length) {
      const all = [...positions, ...unrated];
      const d: Disagreement = { id: `${nodeId}:d${disagreements.length + 1}`, nodeId, item, label, positions: all, blocking: blockers.length > 0 };
      disagreements.push(d);
      f.add({
        kind: "reviewer_disagreement",
        severity: d.blocking ? "blocking" : "major",
        title: differ ? `Reviewers disagree: ${label}` : `Not every reviewer rated: ${label}`,
        detail: all.map((p) => `${p.label}: ${p.verdict ?? p.score ?? "no rating"}. ${p.rationale}`).join("\n"),
        evidence: all.flatMap((p) => p.evidence),
      });
    } else {
      agreed.push({ item, label, verdict: numeric ? null : positions[0].verdict, positions });
      if (blockers.length)
        f.add({ kind: "blocking_verdict", severity: "blocking", status: blockers[0].verdict, title: `${label}: ${blockers[0].verdict}`, detail: positions.map((p) => `${p.label}: ${p.rationale}`).join("\n"), evidence: positions.flatMap((p) => p.evidence) });
    }
  }
  return { agreed, disagreements, scores, findings: f.list() };
}

export function agreeTable(nodeId: string, result: AgreeResult, reviewers: Array<{ key: string; label: string }>) {
  const rows = [
    ...result.agreed.map((a) => ({ item: a.item, label: a.label, positions: a.positions, status: "agreed" })),
    ...result.disagreements.map((d) => ({ item: d.item, label: d.label, positions: d.positions, status: d.blocking ? "blocking" : "disagreed" })),
  ];
  return outcomeTable(
    nodeId,
    "Reviewer agreement",
    [{ key: "item", label: "Item" }, ...reviewers.map((r) => ({ key: `r_${r.key}`, label: r.label })), { key: "status", label: "Agreement" }],
    rows.map((r) => ({
      cells: {
        item: r.label,
        ...Object.fromEntries(reviewers.map((rv) => {
          const p = r.positions.find((x) => x.reviewer === rv.key);
          return [`r_${rv.key}`, p ? String(p.verdict ?? p.score ?? "not rated") : "not rated"];
        })),
        status: r.status === "agreed" ? "Agreed" : r.status === "blocking" ? "Disagreed (blocking)" : "Disagreed",
      },
      status: r.status,
      evidence: r.positions.flatMap((p) => p.evidence),
    })),
  );
}

export const stepAgree: NodeHandler = async (inputs, node) => {
  const config = node.config as AgreeConfig;
  const reviews = flat<Review>(inputs.reviews).filter((r) => r && typeof r.reviewer === "string" && Array.isArray(r.ratings));
  const result = agree(node.node.id, reviews, config);
  const reviewers = [...new Map(reviews.map((r) => [r.reviewer, { key: r.reviewer, label: r.label }])).values()];
  return { ...result, table: agreeTable(node.node.id, result, reviewers) };
};
