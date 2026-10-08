// step.extract: structured items (claims, scores, budget lines, requirements)
// pulled from the material in `from`, each with where it was found. The reply
// schema is built from the configured fields; locations are checked against
// the document text and passage ids against the passages the model was shown.

import { z } from "zod";
import { claudeJson } from "@/lib/llm/claude";
import type { EvidenceLink, ExtractedItem, FieldValue } from "../contract";
import type { NodeHandler } from "../context";
import type { FieldSpec } from "../node-specs/steps";
import { EXTRACT_SYSTEM, dataBlock, documentBlock, notesBlock, sourcesBlock } from "./prompts";
import { asDoc, asNotes, asSources, asTables, callOpts, clip, contains, EvidenceIndex, fieldText, outcomeTable } from "./util";
import type { DocSnapshot, NotesView, SourcesSnapshot, TableView } from "./types";

export type ExtractConfig = {
  item: string;
  fields: FieldSpec[];
  instructions: string;
  from: Array<"document" | "sources" | "data" | "notes">;
  sectionKeys: string[];
  sourceMatch: string[];
  maxItems: number;
};

/** Pure: the zod type for one field. Every field may be null (a list may be empty). */
export function fieldSchema(f: FieldSpec): z.ZodType {
  switch (f.type) {
    case "number":
      return z.number().nullable();
    case "boolean":
      return z.boolean().nullable();
    case "list":
      return z.array(z.string());
    case "enum":
      return f.values?.length ? z.enum(f.values as [string, ...string[]]).nullable() : z.string().nullable();
    case "date":
      return z.string().nullable().describe("ISO date YYYY-MM-DD");
    default:
      return z.string().nullable();
  }
}

/** Pure: the reply schema for a field list. */
export function extractSchema(fields: FieldSpec[]) {
  const shape = Object.fromEntries(fields.map((f) => [f.name, fieldSchema(f)]));
  return z.object({
    items: z.array(
      z.object({
        fields: z.object(shape),
        location: z.object({ section_id: z.string().nullable(), quote: z.string() }),
        source_passages: z.array(z.string()),
      }),
    ),
  });
}
export type ExtractReply = { items: Array<{ fields: Record<string, unknown>; location: { section_id: string | null; quote: string }; source_passages: string[] }> };

/** Pure: an ISO date (YYYY-MM-DD) from what the model wrote, or null. */
export function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Pure: a field value coerced to its spec (enum values outside the list become null). */
export function coerceField(f: FieldSpec, v: unknown): FieldValue {
  if (v === undefined || v === null) return f.type === "list" ? [] : null;
  switch (f.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    case "boolean":
      return typeof v === "boolean" ? v : null;
    case "list":
      return Array.isArray(v) ? v.map((x) => clip(String(x), 500)) : [clip(String(v), 500)];
    case "date":
      return isoDate(v);
    case "enum":
      return f.values?.length && !f.values.includes(String(v)) ? null : clip(String(v), 500);
    default:
      return clip(String(v), 2000);
  }
}

/** The material the model sees, narrowed by sectionKeys and sourceMatch. */
export type ExtractMaterial = { doc: DocSnapshot | null; sources: SourcesSnapshot | null; tables: TableView[]; notes: NotesView | null };

export function narrowMaterial(m: ExtractMaterial, config: Pick<ExtractConfig, "from" | "sourceMatch">): ExtractMaterial {
  const from = new Set(config.from);
  let sources = from.has("sources") ? m.sources : null;
  if (sources && config.sourceMatch.length) {
    const keep = sources.sources.filter((s) => config.sourceMatch.some((w) => contains(`${s.title} ${s.role ?? ""}`, w)));
    const ids = new Set(keep.map((s) => s.id));
    sources = { sources: keep, passages: sources.passages.filter((p) => ids.has(p.sourceId)) };
  }
  return { doc: from.has("document") ? m.doc : null, sources, tables: from.has("data") ? m.tables : [], notes: from.has("notes") ? m.notes : null };
}

export function extractUserPrompt(config: ExtractConfig, m: ExtractMaterial): string {
  const out: string[] = [];
  out.push(`Extract every ${config.item} (at most ${config.maxItems}).`);
  out.push(["Fields:", ...config.fields.map((f) => `- ${f.name} (${f.type}${f.type === "enum" && f.values?.length ? `: ${f.values.join(" | ")}` : ""}${f.required ? ", required" : ""}): ${f.label}. ${f.description}`)].join("\n"));
  if (config.instructions.trim()) out.push(`Instructions: ${config.instructions.trim()}`);
  if (m.doc) out.push(documentBlock(m.doc, { sectionKeys: config.sectionKeys }));
  if (m.sources) out.push(sourcesBlock(m.sources));
  if (config.from.includes("data")) out.push(dataBlock(m.tables));
  if (m.notes) out.push(notesBlock(m.notes));
  return out.join("\n\n");
}

/**
 * Pure: the reply as items with ids I1…, values coerced, the location quote
 * checked against the document (its document link is unverified when the
 * quote isn't found there or in a cited passage) and passage ids the model
 * wasn't shown dropped.
 */
export function buildItems(reply: ExtractReply, config: ExtractConfig, index: EvidenceIndex): ExtractedItem[] {
  return reply.items.slice(0, config.maxItems).map((r, n) => {
    const fields = Object.fromEntries(config.fields.map((f) => [f.name, coerceField(f, r.fields?.[f.name])]));
    const passages = index.links(r.source_passages.map((id) => ({ id })), "for").filter((l) => l.kind === "passage");
    const quote = (r.location?.quote ?? "").trim();
    const location = index.location(r.location?.section_id, quote);
    const evidence: EvidenceLink[] = [];
    if (location && quote) {
      const inDoc = index.inDocument(quote);
      const inPassage = passages.find((p) => contains(index.passages.get(p.ref)?.text ?? "", quote));
      if (inPassage) inPassage.quote = clip(quote, 600);
      if (inDoc || !inPassage) evidence.push({ kind: "document", ref: location.sectionId ?? "doc", sourceId: null, label: location.heading ?? "Document", quote: location.quote, page: null, stance: "neutral", verified: inDoc });
    }
    evidence.push(...passages);
    return { id: `I${n + 1}`, fields, location, evidence: evidence.slice(0, 12) };
  });
}

export function itemsTable(nodeId: string, config: Pick<ExtractConfig, "item" | "fields">, items: ExtractedItem[]) {
  const cap = config.item.charAt(0).toUpperCase() + config.item.slice(1);
  return outcomeTable(
    nodeId,
    `${cap} table`,
    [{ key: "id", label: "Id" }, ...config.fields.map((f) => ({ key: f.name, label: f.label || f.name })), { key: "where", label: "Where" }],
    items.map((it) => ({
      cells: { id: it.id, ...Object.fromEntries(Object.entries(it.fields).map(([k, v]) => [k, fieldText(v)])), where: it.location?.heading ?? "" },
      evidence: it.evidence,
    })),
  );
}

export const stepExtract: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as ExtractConfig;
  const m = narrowMaterial({ doc: asDoc(inputs.document), sources: asSources(inputs.sources), tables: asTables(inputs.data), notes: asNotes(inputs.notes) }, config);
  if (!m.doc && !m.sources?.sources.length && !m.tables.length && !m.notes) return { items: [], table: itemsTable(node.node.id, config, []) };
  // The document stays in the index for location checks even when it isn't read.
  const index = new EvidenceIndex({ doc: asDoc(inputs.document), sources: m.sources, tables: m.tables, notes: m.notes });
  const { data } = await claudeJson({ task: "workflow.extract", system: EXTRACT_SYSTEM, user: extractUserPrompt(config, m), schema: extractSchema(config.fields), ...callOpts(ctx) });
  const items = buildItems(data as ExtractReply, config, index);
  return { items, table: itemsTable(node.node.id, config, items) };
};
