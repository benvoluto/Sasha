// step.simulate: a model plays a reader (a new hire, a beginner, a competent
// practitioner) following the text and logs where it must guess, gets stuck or
// can't tell what it would see. Nothing is executed, so the log says
// `executed: false` and every finding is unverified.

import { z } from "zod";
import { claudeJson } from "@/lib/llm/claude";
import { SEVERITIES, type ExtractedItem, type Finding, type SimulationLog, type SimulationStep } from "../contract";
import type { NodeHandler } from "../context";
import { SIMULATE_SYSTEM, documentBlock, itemsBlock, sourcesBlock } from "./prompts";
import { asDoc, asItems, asSources, callOpts, clip, EvidenceIndex, Findings, outcomeTable } from "./util";
import type { DocSnapshot, SourcesSnapshot } from "./types";

export type SimulateConfig = { persona: string; task: string; rules: string[]; records: "steps" | "gaps" | "answers"; questions: string[] };

export const SIMULATED = "Simulated: nothing was run.";

const at = { section_id: z.string().nullable(), quote: z.string() };
export const SimulateModelOutput = z.object({
  steps: z.array(z.object({ step: z.string(), stated: z.string(), observed: z.string(), ok: z.boolean(), note: z.string(), ...at })),
  stopped_at: z.string().nullable(),
  gaps: z.array(z.object({ title: z.string(), detail: z.string(), severity: z.enum(SEVERITIES), ...at })),
  answers: z.array(z.object({ question: z.string(), answer: z.string(), found: z.boolean(), ...at })),
});
export type SimulateModelOutput = z.infer<typeof SimulateModelOutput>;

export function simulateUserPrompt(config: SimulateConfig, m: { doc: DocSnapshot | null; sources: SourcesSnapshot | null; items: ExtractedItem[] }): string {
  const out: string[] = [];
  out.push(`Persona: ${config.persona}`);
  out.push(`Task: ${config.task}`);
  if (config.rules.length) out.push(["Rules:", ...config.rules.map((r) => `- ${r}`)].join("\n"));
  const what = { steps: "Log every step: its stated result and what you would actually see.", gaps: "Log every point where you must guess (steps too, briefly).", answers: "Answer each question from the text alone; found = false when the text doesn't answer it." };
  out.push(what[config.records]);
  if (config.questions.length) out.push(["Questions:", ...config.questions.map((q, i) => `${i + 1}. ${q}`)].join("\n"));
  if (m.doc) out.push(documentBlock(m.doc));
  if (m.items.length) out.push(itemsBlock(m.items));
  if (m.sources) out.push(sourcesBlock(m.sources));
  return out.join("\n\n");
}

/** Pure: the walkthrough log. Locations are checked against the document; executed is always false. */
export function buildLog(config: SimulateConfig, reply: SimulateModelOutput, index: EvidenceIndex): SimulationLog {
  const steps: SimulationStep[] = reply.steps.slice(0, 200).map((s) => ({
    step: clip(s.step, 1000),
    stated: clip(s.stated, 1000),
    observed: clip(s.observed, 1000),
    ok: s.ok,
    note: clip(s.note, 1000),
    location: index.location(s.section_id, s.quote),
  }));
  return { persona: config.persona, steps, stoppedAt: reply.stopped_at?.trim() ? clip(reply.stopped_at.trim(), 500) : null, executed: false };
}

/** Pure: findings, all unverified ("Simulated: nothing was run"). A stop is kind walkthrough_failed. */
export function simulateFindings(nodeId: string, log: SimulationLog, reply: SimulateModelOutput, index: EvidenceIndex): Finding[] {
  const f = new Findings(nodeId);
  const sim = (s: string) => `${SIMULATED} ${s}`.trim();
  const docLink = (loc: ReturnType<EvidenceIndex["location"]>) =>
    loc ? [{ kind: "document" as const, ref: loc.sectionId ?? "doc", sourceId: null, label: loc.heading ?? "Document", quote: loc.quote, page: null, stance: "neutral" as const, verified: false }] : [];
  if (log.stoppedAt) {
    const stop = log.steps.find((s) => !s.ok) ?? null;
    f.add({ kind: "walkthrough_failed", severity: "major", title: `The walkthrough stopped: ${clip(log.stoppedAt, 200)}`, detail: sim(stop?.note || stop?.observed || ""), location: stop?.location ?? null, evidence: docLink(stop?.location ?? null), verified: false });
  }
  for (const s of log.steps) {
    if (s.ok) continue;
    f.add({ kind: "walkthrough_step", severity: "minor", title: `Step didn't go as written: ${clip(s.step, 200)}`, detail: sim(`Expected: ${s.stated || "(no result stated)"}. Observed: ${s.observed}. ${s.note}`), location: s.location, evidence: docLink(s.location), verified: false });
  }
  for (const g of reply.gaps) {
    const loc = index.location(g.section_id, g.quote);
    f.add({ kind: "walkthrough_gap", severity: g.severity === "blocking" ? "major" : g.severity, title: clip(g.title, 300), detail: sim(g.detail), location: loc, evidence: docLink(loc), verified: false });
  }
  for (const a of reply.answers) {
    if (a.found) continue;
    const loc = index.location(a.section_id, a.quote);
    f.add({ kind: "unanswered", severity: "minor", title: `Not answered by the text: ${clip(a.question, 250)}`, detail: sim(a.answer), location: loc, evidence: docLink(loc), verified: false });
  }
  return f.list();
}

export function simulateTable(nodeId: string, log: SimulationLog) {
  return outcomeTable(
    nodeId,
    `Walkthrough (simulated): ${clip(log.persona, 120)}`,
    [
      { key: "step", label: "Step" },
      { key: "stated", label: "Stated result" },
      { key: "observed", label: "Observed (simulated)" },
      { key: "ok", label: "OK" },
    ],
    log.steps.map((s) => ({ cells: { step: s.step, stated: s.stated, observed: s.observed, ok: s.ok ? "Yes" : "No" }, status: s.ok ? "ok" : "failed" })),
  );
}

export const stepSimulate: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as SimulateConfig;
  const m = { doc: asDoc(inputs.document), sources: asSources(inputs.sources), items: asItems(inputs.items) };
  const index = new EvidenceIndex({ doc: m.doc, sources: m.sources });
  const { data } = await claudeJson({ task: "workflow.check", system: SIMULATE_SYSTEM, user: simulateUserPrompt(config, m), schema: SimulateModelOutput, ...callOpts(ctx) });
  const log = buildLog(config, data, index);
  return { log, findings: simulateFindings(node.node.id, log, data, index), table: simulateTable(node.node.id, log) };
};
