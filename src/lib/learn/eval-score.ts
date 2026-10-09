// Scoring for the learn-from-example evaluation (PLAN §6.11 "Evaluation
// (round trip)", scripts/learn/evaluate.ts): how close a generated document's
// structure is to the example's, how many of the example's key points it
// covers, which condition did best, and the summary and Markdown report.
//
// Pure (no network, no model): the harness gathers the inputs and these
// functions turn them into numbers, so they are unit-tested with fixtures.

import { EVAL_CONDITIONS, type EvalCaseResult, type EvalCondition, type EvalConditionResult, type EvalReport, type EvalScores } from "./contract";

const STOP = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "by", "at", "from", "as", "is", "are", "our", "your", "its"]);

/** A heading's comparable words: lowercase, numbering ("2.", "IV.", "A)") and punctuation gone, stopwords dropped. */
export function headingWords(heading: string): string[] {
  return heading
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*|[ivxlc]+|[a-z])[.)]\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w));
}

/** Word overlap (Jaccard) between two headings, 0..1. Two headings with no words left compare equal only when both are empty. */
export function headingSimilarity(a: string, b: string): number {
  const x = new Set(headingWords(a));
  const y = new Set(headingWords(b));
  if (!x.size || !y.size) return x.size === y.size ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Headings that match: at least this much word overlap, or one's words all inside the other's ("Budget" and "Budget justification"). */
export const HEADING_MATCH = 0.5;

export function headingsMatch(a: string, b: string): boolean {
  if (headingSimilarity(a, b) >= HEADING_MATCH) return true;
  const x = headingWords(a);
  const y = headingWords(b);
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.length > 0 && short.every((w) => long.has(w));
}

/**
 * Order-aware section match: the longest run of matching headings that appear
 * in the same order in both lists (a longest common subsequence under
 * headingsMatch), as an F1 of precision over the generated headings and recall
 * over the example's. 1 when both are empty.
 */
export function structureScore(example: string[], generated: string[]): { f1: number; precision: number; recall: number; matched: number } {
  if (!example.length && !generated.length) return { f1: 1, precision: 1, recall: 1, matched: 0 };
  if (!example.length || !generated.length) return { f1: 0, precision: 0, recall: 0, matched: 0 };
  const m = example.length;
  const n = generated.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) dp[i][j] = headingsMatch(example[i - 1], generated[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  const matched = dp[m][n];
  const precision = matched / n;
  const recall = matched / m;
  return { f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, precision, recall, matched };
}

export type CoverageVerdict = "covered" | "partial" | "missing";

/** Share of key points covered: covered counts 1, partial ½. 0 with no key points. */
export function coverageScore(verdicts: CoverageVerdict[]): number {
  if (!verdicts.length) return 0;
  return verdicts.reduce((s, v) => s + (v === "covered" ? 1 : v === "partial" ? 0.5 : 0), 0) / verdicts.length;
}

/** Mean of rubric levels on a 0..10 scale, or null with none. */
export function meanRubric(levels: number[]): number | null {
  return levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null;
}

/** The comparison score: structure + coverage + rubric/10, equal weights (rubric counts 0 when it wasn't run). */
export const combinedScore = (s: EvalScores) => s.structure + s.coverage + (s.rubric ?? 0) / 10;

/** The best condition in a case, or null when every condition failed. Ties go to the earlier condition (extracted, nearest, none). */
export function bestCondition(results: EvalConditionResult[]): EvalCondition | null {
  let best: EvalConditionResult | null = null;
  for (const r of results) if (r.scores && (!best || combinedScore(r.scores) > combinedScore(best.scores!))) best = r;
  return best?.condition ?? null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The report's summary: means per condition, how often extracted beat nearest, and the verdict. */
export function summarize(cases: EvalCaseResult[]): EvalReport["summary"] {
  const byCondition = Object.fromEntries(
    EVAL_CONDITIONS.map((c) => {
      const scored = cases.map((k) => k.conditions.find((r) => r.condition === c)?.scores).filter((s): s is EvalScores => !!s);
      const rubrics = scored.map((s) => s.rubric).filter((r): r is number => r !== null);
      return [c, { structure: mean(scored.map((s) => s.structure)), coverage: mean(scored.map((s) => s.coverage)), rubric: rubrics.length ? mean(rubrics) : null, cases: scored.length }];
    }),
  ) as EvalReport["summary"]["byCondition"];
  let comparable = 0;
  let wins = 0;
  for (const k of cases) {
    const ex = k.conditions.find((r) => r.condition === "extracted")?.scores;
    const near = k.conditions.find((r) => r.condition === "nearest")?.scores;
    if (!ex || !near) continue;
    comparable++;
    if (combinedScore(ex) > combinedScore(near)) wins++;
  }
  const verdict = comparable < 2 ? "inconclusive" : wins * 2 > comparable ? "beats-nearest" : "does-not-beat-nearest";
  return { byCondition, extractedBeatsNearest: wins, total: cases.length, verdict };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (x: number | null) => (x === null ? "–" : x.toFixed(1));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The report as Markdown (written beside report.json). */
export function reportMarkdown(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    "# Learn from an example: evaluation",
    "",
    `Ran ${report.ranAt}. Models: ${Object.entries(report.models).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
    `**Verdict: ${s.verdict}** (extracted beat nearest in ${s.extractedBeatsNearest} of ${s.total} cases).`,
    "",
    "| Condition | Structure | Coverage | Rubric | Cases |",
    "|---|---|---|---|---|",
    ...EVAL_CONDITIONS.map((c) => `| ${c} | ${pct(s.byCondition[c].structure)} | ${pct(s.byCondition[c].coverage)} | ${num(s.byCondition[c].rubric)} | ${s.byCondition[c].cases} |`),
    "",
  ];
  for (const k of report.cases) {
    lines.push(`## ${cell(k.title)} (${k.caseId}, ${k.family})`, "");
    if (k.extraction) lines.push(`Extraction: ${k.extraction.confidence} confidence, ${k.extraction.overlaps} overlap flag(s), ${k.extraction.personalDetails} personal detail(s) removed.`, "");
    lines.push("| Condition | Type | Structure | Coverage | Rubric | Findings (b/w/i) | Outcome | Error |", "|---|---|---|---|---|---|---|---|");
    for (const r of k.conditions) {
      const sc = r.scores;
      lines.push(
        `| ${r.condition}${k.best === r.condition ? " ★" : ""} | ${r.typeKey ?? "–"} | ${sc ? pct(sc.structure) : "–"} | ${sc ? pct(sc.coverage) : "–"} | ${sc ? num(sc.rubric) : "–"} | ${sc ? `${sc.findings.blocking}/${sc.findings.warning}/${sc.findings.info}` : "–"} | ${sc?.outcome ?? "–"} | ${r.error ? cell(r.error) : ""} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
