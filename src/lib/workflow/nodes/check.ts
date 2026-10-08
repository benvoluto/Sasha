// step.check: checklist questions answered against the document (or, with
// perItem, against each item), each with a status from the configured list, a
// rationale and the evidence behind it. A question the model skipped is
// reported as not assessed rather than passed.

import { z } from "zod";
import { claudeJson } from "@/lib/llm/claude";
import type { CheckResult, ExtractedItem, Finding, Severity } from "../contract";
import type { NodeHandler } from "../context";
import type { CheckItem, StatusSpec } from "../node-specs/steps";
import { CHECK_SYSTEM, dataBlock, documentBlock, itemsBlock, requirementsBlock, sourcesBlock } from "./prompts";
import { asDoc, asItems, asRequirements, asSources, asTables, callOpts, downgradeStatus, EvidenceIndex, Findings, itemName, outcomeTable, severityRank, statusFor } from "./util";
import type { DocSnapshot, RequirementsView, SourcesSnapshot, TableView } from "./types";

export type CheckConfig = { checklist: CheckItem[]; statuses: StatusSpec[]; perItem: boolean; instructions: string };
export type CheckMaterial = { doc: DocSnapshot | null; sources: SourcesSnapshot | null; items: ExtractedItem[]; requirements: RequirementsView | null; tables: TableView[] };

export const NOT_ASSESSED = "not_assessed";

export const checkSchema = (config: CheckConfig) =>
  z.object({
    results: z.array(
      z.object({
        check: z.enum(config.checklist.map((c) => c.key) as [string, ...string[]]),
        item: z.string().nullable(),
        status: z.enum(config.statuses.map((s) => s.key) as [string, ...string[]]),
        rationale: z.string(),
        evidence: z.array(z.object({ id: z.string(), quote: z.string() })),
      }),
    ),
  });
export type CheckReply = { results: Array<{ check: string; item: string | null; status: string; rationale: string; evidence: Array<{ id: string; quote: string }> }> };

export function checkUserPrompt(config: CheckConfig, m: CheckMaterial): string {
  const out: string[] = [];
  out.push(["Allowed statuses:", ...config.statuses.map((s) => `- ${s.key}: ${s.label}`)].join("\n"));
  const sectionsFor = (c: CheckItem) => (c.appliesTo.length ? ` (read the sections: ${c.appliesTo.join(", ")})` : "");
  out.push(["Questions (key: question):", ...config.checklist.map((c) => `- ${c.key}: ${c.question}${sectionsFor(c)}`)].join("\n"));
  out.push(config.perItem ? "Answer every question for every item in <items>: one result per question and item id (item = the item id)." : "Answer every question once for the whole document (item = null).");
  if (config.instructions.trim()) out.push(`Instructions: ${config.instructions.trim()}`);
  if (m.doc) out.push(documentBlock(m.doc));
  if (m.items.length) out.push(itemsBlock(m.items));
  if (m.sources) out.push(sourcesBlock(m.sources));
  if (m.tables.length) out.push(dataBlock(m.tables));
  if (m.requirements) out.push(requirementsBlock(m.requirements));
  return out.join("\n\n");
}

/**
 * Pure: one result per question (and item). Unknown question or item ids are
 * dropped; a missing answer becomes "not_assessed"; a passing answer whose
 * every cited id was unknown falls to the most severe failing status.
 */
export function buildResults(reply: CheckReply, config: CheckConfig, m: CheckMaterial, index: EvidenceIndex): CheckResult[] {
  const itemIds: Array<string | null> = config.perItem ? m.items.map((i) => i.id) : [null];
  const key = (check: string, item: string | null) => `${check}\u0000${item ?? ""}`;
  const got = new Map<string, CheckReply["results"][number]>();
  for (const r of reply.results) {
    const item = config.perItem ? (r.item?.trim() ?? null) : null;
    if (config.perItem && (!item || !itemIds.includes(item))) continue;
    if (!got.has(key(r.check, item))) got.set(key(r.check, item), r);
  }
  const out: CheckResult[] = [];
  for (const c of config.checklist) {
    for (const item of itemIds) {
      const r = got.get(key(c.key, item));
      if (!r) {
        out.push({ check: c.key, label: c.label, itemId: item, status: NOT_ASSESSED, rationale: "The model gave no answer for this question.", evidence: [] });
        continue;
      }
      const evidence = index.links(r.evidence);
      let status = statusFor(config.statuses, r.status);
      let rationale = r.rationale;
      if (status.ok && r.evidence.length && !evidence.length) {
        status = downgradeStatus(config.statuses);
        rationale = `${rationale} (Its cited support could not be found in the material.)`;
      }
      out.push({ check: c.key, label: c.label, itemId: item, status: status.key, rationale, evidence });
    }
  }
  return out;
}

/** A failing status at "major" or worse takes the question's severity; a milder one keeps the milder of the two. */
export function resultSeverity(status: StatusSpec, check: CheckItem): Severity {
  if (severityRank(status.severity) <= severityRank("major")) return check.severity;
  return severityRank(status.severity) > severityRank(check.severity) ? status.severity : check.severity;
}

export function checkFindings(nodeId: string, results: CheckResult[], config: CheckConfig, m: CheckMaterial, index: EvidenceIndex): Finding[] {
  const f = new Findings(nodeId);
  const checks = new Map(config.checklist.map((c) => [c.key, c]));
  const items = new Map(m.items.map((i) => [i.id, i]));
  for (const r of results) {
    const check = checks.get(r.check)!;
    const item = r.itemId ? items.get(r.itemId) : undefined;
    const subject = item ? ` (${item.id} ${itemName(item)})` : "";
    if (r.status === NOT_ASSESSED) {
      f.add({ kind: NOT_ASSESSED, severity: "minor", status: NOT_ASSESSED, title: `Not assessed: ${check.label}${subject}`, detail: r.rationale, location: item?.location ?? null });
      continue;
    }
    const s = statusFor(config.statuses, r.status);
    if (s.ok) continue;
    const firstSection = r.evidence.find((e) => e.kind === "document");
    const location = item?.location ?? (firstSection ? index.location(firstSection.ref, firstSection.quote) : null);
    f.add({ kind: check.key, severity: resultSeverity(s, check), status: s.key, title: `${check.label}${subject}: ${s.label}`, detail: r.rationale, location, evidence: r.evidence });
  }
  return f.list();
}

export function checkTable(nodeId: string, results: CheckResult[], config: CheckConfig) {
  return outcomeTable(
    nodeId,
    "Checklist",
    [
      { key: "check", label: "Check" },
      ...(config.perItem ? [{ key: "item", label: "Item" }] : []),
      { key: "status", label: "Status" },
      { key: "why", label: "Why" },
    ],
    results.map((r) => ({ cells: { check: r.label, ...(config.perItem ? { item: r.itemId ?? "" } : {}), status: r.status === NOT_ASSESSED ? "Not assessed" : statusFor(config.statuses, r.status).label, why: r.rationale }, status: r.status, evidence: r.evidence })),
  );
}

export const stepCheck: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as CheckConfig;
  const m: CheckMaterial = { doc: asDoc(inputs.document), sources: asSources(inputs.sources), items: asItems(inputs.items), requirements: asRequirements(inputs.requirements), tables: asTables(inputs.data) };
  const id = node.node.id;
  if (config.perItem && !m.items.length) return { results: [], findings: [], table: checkTable(id, [], config) };
  const index = new EvidenceIndex({ doc: m.doc, sources: m.sources, tables: m.tables, items: m.items.map((i) => [i.id, i] as [string, ExtractedItem]), requirements: m.requirements });
  const { data } = await claudeJson({ task: "workflow.check", system: CHECK_SYSTEM, user: checkUserPrompt(config, m), schema: checkSchema(config), ...callOpts(ctx) });
  const results = buildResults(data as CheckReply, config, m, index);
  return { results, findings: checkFindings(id, results, config, m, index), table: checkTable(id, results, config) };
};
