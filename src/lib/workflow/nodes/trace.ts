// step.trace: each item linked to its support (source passages, target items,
// the document) with a status. With nothing to check against (claims about
// code, or no sources linked) it makes no model call and marks every item
// unverified. bothWays also flags targets no item links to, except a target
// whose exemptField is filled in (a need the draft gives a reason for no goal),
// which is noted instead.

import { z } from "zod";
import { claudeJson } from "@/lib/llm/claude";
import type { ExtractedItem, Finding, TracedItem } from "../contract";
import type { NodeHandler } from "../context";
import type { StatusSpec } from "../node-specs/steps";
import { TRACE_SYSTEM, dataBlock, documentBlock, itemsBlock, sourcesBlock } from "./prompts";
import { asDoc, asItems, asSources, asTables, callOpts, downgradeStatus, EvidenceIndex, Findings, itemName, outcomeTable, statusFor } from "./util";
import type { DocSnapshot, SourcesSnapshot, TableView } from "./types";

export type TraceConfig = {
  against: "sources" | "targets" | "document" | "code";
  statuses: StatusSpec[];
  unverifiedStatus: string;
  question: string;
  bothWays: boolean;
  /** A target with this field filled in is exempt from the bothWays flag; "" for none. */
  exemptField?: string;
  instructions: string;
};

export type TraceMaterial = { items: ExtractedItem[]; targets: ExtractedItem[]; sources: SourcesSnapshot | null; doc: DocSnapshot | null; tables: TableView[] };

/** Pure: why nothing can be checked, or null when a model call can trace the items. */
export function nothingToCheck(config: Pick<TraceConfig, "against">, m: TraceMaterial): string | null {
  if (config.against === "code") return "Sasha has no access to the code or system these claims are about, so they could not be checked.";
  if (config.against === "sources" && !m.sources?.sources.length) return "No sources are linked, so these items could not be checked against them.";
  if (config.against === "targets" && !m.targets.length) return "There were no target items to trace against.";
  if (config.against === "document" && !m.doc) return "The document was not given to this step.";
  return null;
}

export const traceSchema = (statuses: StatusSpec[]) =>
  z.object({
    items: z.array(
      z.object({
        id: z.string(),
        status: z.enum(statuses.map((s) => s.key) as [string, ...string[]]),
        evidence: z.array(z.object({ id: z.string(), quote: z.string() })),
        linked_targets: z.array(z.string()),
        rationale: z.string(),
      }),
    ),
  });
export type TraceReply = { items: Array<{ id: string; status: string; evidence: Array<{ id: string; quote: string }>; linked_targets: string[]; rationale: string }> };

/** Target items are shown as T1…, so they can't be confused with the items being traced. */
export const targetAlias = (n: number) => `T${n + 1}`;

export function traceUserPrompt(config: TraceConfig, m: TraceMaterial): string {
  const out: string[] = [];
  out.push(`Question: ${config.question}`);
  out.push(["Allowed statuses:", ...config.statuses.map((s) => `- ${s.key}: ${s.label}${s.ok ? " (passes)" : ""}`)].join("\n"));
  if (config.instructions.trim()) out.push(`Instructions: ${config.instructions.trim()}`);
  out.push(itemsBlock(m.items, { role: "trace" }));
  if (config.against === "targets") out.push(itemsBlock(m.targets, { role: "targets", ids: m.targets.map((_, i) => targetAlias(i)) }));
  if (config.against === "sources") out.push(sourcesBlock(m.sources));
  if (config.against === "document" && m.doc) out.push(documentBlock(m.doc));
  if (m.tables.length) out.push(dataBlock(m.tables));
  return out.join("\n\n");
}

/** Pure: every item unverified (no model call). */
export function unverifiedTrace(items: ExtractedItem[], config: TraceConfig, why: string): TracedItem[] {
  return items.map((it) => ({ ...it, status: statusFor(config.statuses, config.unverifiedStatus).key, rationale: why, linkedTargets: [] }));
}

/**
 * Pure: the reply applied to the items. Unknown item and target ids are
 * dropped; an item the model skipped is unverified; a passing status with no
 * checkable support falls to the most severe failing status.
 */
export function applyTrace(reply: TraceReply, config: TraceConfig, m: TraceMaterial, index: EvidenceIndex): TracedItem[] {
  const byId = new Map(reply.items.map((r) => [r.id.trim(), r]));
  const aliases = new Map(m.targets.map((t, i) => [targetAlias(i), t.id]));
  return m.items.map((it) => {
    const r = byId.get(it.id);
    if (!r) return { ...it, status: statusFor(config.statuses, config.unverifiedStatus).key, rationale: "The model gave no verdict for this item.", linkedTargets: [] };
    const linkedTargets = [...new Set(r.linked_targets.map((t) => aliases.get(t.trim())).filter((t): t is string => !!t))];
    const evidence = index.links(r.evidence, "for");
    let status = statusFor(config.statuses, r.status);
    let rationale = r.rationale;
    const support = evidence.filter((e) => e.verified).length + (config.against === "targets" ? linkedTargets.length : 0);
    if (status.ok && !support) {
      status = downgradeStatus(config.statuses);
      rationale = `${rationale} (No checkable support was cited.)`.trim();
    }
    return { ...it, evidence: [...it.evidence, ...evidence].slice(0, 12), status: status.key, rationale, linkedTargets };
  });
}

/** The stated reason a target needs no link (its exemptField, filled in), or "". */
function exemptReason(target: ExtractedItem, field: string | undefined): string {
  if (!field) return "";
  const v = target.fields[field];
  return (Array.isArray(v) ? v.join("; ") : v === null || v === undefined ? "" : String(v)).trim();
}

/** Pure: findings for failing statuses, and (bothWays) for targets nothing links to. */
export function traceFindings(nodeId: string, traced: TracedItem[], config: TraceConfig, m: TraceMaterial, verified: boolean): Finding[] {
  const f = new Findings(nodeId);
  for (const t of traced) {
    const s = statusFor(config.statuses, t.status);
    if (s.ok) continue;
    f.add({ kind: s.key, severity: s.severity, status: s.key, title: `${s.label}: ${itemName(t)}`, detail: t.rationale, location: t.location, evidence: t.evidence, verified: verified && s.key !== config.unverifiedStatus });
  }
  if (config.bothWays && config.against === "targets") {
    const linked = new Set(traced.flatMap((t) => t.linkedTargets));
    for (const target of m.targets) {
      if (linked.has(target.id)) continue;
      const evidence = [{ kind: "item" as const, ref: target.id, sourceId: null, label: itemName(target), quote: "", page: null, stance: "neutral" as const, verified: true }];
      const reason = exemptReason(target, config.exemptField);
      if (reason) f.add({ kind: "exempt_target", severity: "info", title: `No link, reason stated: ${itemName(target)}`, detail: reason, location: target.location, evidence, verified });
      else f.add({ kind: "untraced_target", severity: "major", title: `Nothing links to: ${itemName(target)}`, detail: "No item traces to this one.", location: target.location, evidence, verified });
    }
  }
  return f.list();
}

export function traceTable(nodeId: string, traced: TracedItem[], config: TraceConfig) {
  return outcomeTable(
    nodeId,
    "Trace",
    [
      { key: "item", label: "Item" },
      { key: "status", label: "Status" },
      { key: "links", label: "Linked to" },
      { key: "why", label: "Why" },
    ],
    traced.map((t) => ({ cells: { item: `${t.id} ${itemName(t)}`, status: statusFor(config.statuses, t.status).label, links: t.linkedTargets.join(", "), why: t.rationale }, status: t.status, evidence: t.evidence })),
  );
}

export const stepTrace: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as TraceConfig;
  const m: TraceMaterial = { items: asItems(inputs.items), targets: asItems(inputs.targets), sources: asSources(inputs.sources), doc: asDoc(inputs.document), tables: asTables(inputs.data) };
  const id = node.node.id;
  if (!m.items.length) return { traced: [], findings: [], table: traceTable(id, [], config) };
  const why = nothingToCheck(config, m);
  if (why) {
    const traced = unverifiedTrace(m.items, config, why);
    return { traced, findings: traceFindings(id, traced, config, m, false), table: traceTable(id, traced, config) };
  }
  const index = new EvidenceIndex({ doc: m.doc, sources: m.sources, tables: m.tables, items: m.targets.map((t, i) => [targetAlias(i), t] as [string, ExtractedItem]) });
  const { data } = await claudeJson({ task: "workflow.trace", system: TRACE_SYSTEM, user: traceUserPrompt(config, m), schema: traceSchema(config.statuses), ...callOpts(ctx) });
  const traced = applyTrace(data as TraceReply, config, m, index);
  return { traced, findings: traceFindings(id, traced, config, m, true), table: traceTable(id, traced, config) };
};
