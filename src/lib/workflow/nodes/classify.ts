// step.classify: each paragraph (a top-level block of the document) or item
// sorted into fixed categories; units in flagged categories become findings
// carrying the category's suggestion as their fix (Diátaxis: "this teaching
// belongs in a tutorial").

import { z } from "zod";
import { claudeJson } from "@/lib/llm/claude";
import { nodeText, type PMNode } from "@/lib/documents/sections";
import type { ClassifiedUnit, ExtractedItem, Finding, Severity } from "../contract";
import type { NodeHandler } from "../context";
import { CLASSIFY_SYSTEM, defuseAll, tagBlock } from "./prompts";
import { sectionIdOf } from "./readers";
import { asItems, callOpts, clip, Findings, itemName, outcomeTable } from "./util";

export type Category = { key: string; label: string; description: string; flag: boolean; severity: Severity; suggestion: string };
export type ClassifyConfig = { unit: "paragraph" | "item"; categories: Category[]; instructions: string };

/** A unit to classify: a paragraph ("<sectionId>#<n>") or an item. */
export type Unit = { id: string; sectionId: string | null; heading: string | null; text: string };

export const MAX_UNITS = 200;
const UNIT_CHARS = 1500;

/**
 * Pure: the document's paragraphs, each top-level block with text under its
 * heading, numbered from 1 within the section ("<sectionId>#<n>"). Blocks
 * before the first heading are "doc#<n>".
 */
export function paragraphUnits(doc: PMNode): Unit[] {
  const out: Unit[] = [];
  let sectionId: string | null = null;
  let heading: string | null = null;
  let n = 0;
  (doc.content ?? []).forEach((node, index) => {
    if (node.type === "heading") {
      sectionId = sectionIdOf(String(node.attrs?.sectionId ?? ""), index);
      heading = nodeText(node).trim();
      n = 0;
      return;
    }
    const text = nodeText(node).trim();
    if (!text || out.length >= MAX_UNITS) return;
    n++;
    out.push({ id: `${sectionId ?? "doc"}#${n}`, sectionId, heading, text: clip(text, UNIT_CHARS) });
  });
  return out;
}

export function itemUnits(items: ExtractedItem[]): Unit[] {
  return items.slice(0, MAX_UNITS).map((i) => ({ id: i.id, sectionId: i.location?.sectionId ?? null, heading: i.location?.heading ?? null, text: clip(itemName(i), UNIT_CHARS) }));
}

export const classifySchema = (config: ClassifyConfig) =>
  z.object({ units: z.array(z.object({ id: z.string(), category: z.enum(config.categories.map((c) => c.key) as [string, ...string[]]), rationale: z.string() })) });
export type ClassifyReply = { units: Array<{ id: string; category: string; rationale: string }> };

export function classifyUserPrompt(config: ClassifyConfig, units: Unit[]): string {
  const out: string[] = [];
  out.push(["Categories (key: label; description):", ...config.categories.map((c) => `- ${c.key}: ${c.label}; ${c.description}`)].join("\n"));
  if (config.instructions.trim()) out.push(`Instructions: ${config.instructions.trim()}`);
  out.push(tagBlock("items", units.map((u) => tagBlock("item", defuseAll(u.text), { id: u.id, ...(u.heading ? { heading: u.heading } : {}) })).join("\n"), { role: "units" }));
  return out.join("\n\n");
}

/** Pure: one classified unit per unit the model labelled (unknown unit ids dropped). */
export function buildClassified(reply: ClassifyReply, units: Unit[]): ClassifiedUnit[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const out = new Map<string, ClassifiedUnit>();
  for (const r of reply.units) {
    const u = byId.get(r.id.trim());
    if (u && !out.has(u.id)) out.set(u.id, { unitId: u.id, sectionId: u.sectionId, excerpt: clip(u.text, 300), category: r.category, rationale: clip(r.rationale, 1000) });
  }
  return units.flatMap((u) => out.get(u.id) ?? []);
}

export function classifyFindings(nodeId: string, classified: ClassifiedUnit[], config: ClassifyConfig, units: Unit[]): Finding[] {
  const f = new Findings(nodeId);
  const cats = new Map(config.categories.map((c) => [c.key, c]));
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const c of classified) {
    const cat = cats.get(c.category);
    if (!cat?.flag) continue;
    const u = byId.get(c.unitId)!;
    const quote = clip(u.text, 300);
    f.add({
      kind: cat.key,
      severity: cat.severity,
      status: cat.key,
      title: `${cat.label}: “${clip(u.text, 80)}”`,
      detail: c.rationale,
      location: { sectionId: u.sectionId, specKey: null, heading: u.heading, quote },
      evidence: [{ kind: config.unit === "item" ? "item" : "document", ref: config.unit === "item" ? u.id : (u.sectionId ?? "doc"), sourceId: null, label: u.heading ?? "Document", quote, page: null, stance: "neutral", verified: true }],
      fix: cat.suggestion ? `Move this to ${cat.suggestion}.` : "",
    });
  }
  return f.list();
}

export function classifyTable(nodeId: string, classified: ClassifiedUnit[], config: ClassifyConfig) {
  const cats = new Map(config.categories.map((c) => [c.key, c]));
  return outcomeTable(
    nodeId,
    "Classification",
    [
      { key: "unit", label: "Passage" },
      { key: "category", label: "Category" },
      { key: "why", label: "Why" },
    ],
    classified.map((c) => ({ cells: { unit: c.excerpt, category: cats.get(c.category)?.label ?? c.category, why: c.rationale }, status: cats.get(c.category)?.flag ? "flagged" : "ok" })),
  );
}

export const stepClassify: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as ClassifyConfig;
  const units = config.unit === "item" ? itemUnits(asItems(inputs.items)) : paragraphUnits((await ctx.document()).content_json);
  const id = node.node.id;
  if (!units.length) return { classified: [], findings: [], table: classifyTable(id, [], config) };
  const { data } = await claudeJson({ task: "workflow.check", system: CLASSIFY_SYSTEM, user: classifyUserPrompt(config, units), schema: classifySchema(config), ...callOpts(ctx) });
  const classified = buildClassified(data as ClassifyReply, units);
  return { classified, findings: classifyFindings(id, classified, config, units), table: classifyTable(id, classified, config) };
};
