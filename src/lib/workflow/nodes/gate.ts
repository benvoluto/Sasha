// step.gate (phase6-spec.md §3.1): are the workflow's required inputs present?
// Keywords first (pure, below); with useModel, the inputs keywords couldn't
// confirm go to one fast-model check over source summaries, section starts and
// notes. Missing required inputs make `blocked`; otherwise `pass`. Optional
// inputs are reported and never block.

import { z } from "zod";
import { claudeJson } from "@/lib/llm/claude";
import type { EvidenceLink, GateItem, GateReport } from "../contract";
import type { NodeHandler } from "../context";
import type { GateInput } from "../node-specs/steps";
import { GATE_SYSTEM, defuseAll, notesBlock, tagBlock } from "./prompts";
import { asDoc, asNotes, asSources, asTables, callOpts, clip, containsKeyword, EvidenceIndex } from "./util";
import type { DocSnapshot, NotesView, SourceView, TableView } from "./types";

export type GateMaterial = { doc: DocSnapshot | null; sources: SourceView[]; tables: TableView[]; notes: NotesView | null };

const ev = (kind: EvidenceLink["kind"], ref: string, label: string, quote = "", sourceId: string | null = null): EvidenceLink => ({ kind, ref, label: clip(label, 300), quote, sourceId, page: null, stance: "for", verified: true });

const PLACEHOLDER = /\[[^\]\n]{1,80}\]/g;

/**
 * Pure: the text without the type's unfilled template lines. A scaffold row
 * ("Most recent evaluation\t[YYYY-MM-DD]", "**Date:** [Date]") names the
 * input it asks for, so keywords would find the input in the template itself.
 * A line goes when it has a [placeholder] and nothing but placeholders and
 * punctuation after its label (the first cell, or the text before a colon).
 * Table cells end in a newline in the plain text ("Label\n\t[Value]"), so a
 * row is joined back onto one line first.
 */
export function withoutTemplateLines(text: string): string {
  return text
    .replace(/\n+\t/g, "\t")
    .split("\n")
    .filter((line) => {
      if (!line.match(PLACEHOLDER)) return true;
      const cells = line.split("\t");
      const colon = line.indexOf(":");
      const value = cells.length > 1 ? cells.slice(1).join(" ") : colon >= 0 ? line.slice(colon + 1) : line;
      return /[\p{L}\p{N}]/u.test(value.replace(PLACEHOLDER, ""));
    })
    .join("\n");
}

const firstMatch = (texts: Array<string | null | undefined>, words: string[]) => words.find((w) => texts.some((t) => t && containsKeyword(t, w)));

/** Pure: where keywords find one input, as evidence links (empty: not found). */
export function keywordEvidence(input: GateInput, m: GateMaterial): EvidenceLink[] {
  const words = input.match;
  const bySource = (): EvidenceLink[] =>
    words.length
      ? m.sources.flatMap((s) => {
          const w = firstMatch([s.title, s.role, s.summary, s.url], words);
          return w ? [ev("source", s.id, s.title, w, s.id)] : [];
        })
      : [];
  const byData = (): EvidenceLink[] =>
    m.tables.flatMap((t) => {
      if (!words.length) return [ev("data", t.id, t.name, "", t.sourceId)];
      const w = firstMatch([t.name, ...t.columns.map((c) => c.label)], words);
      return w ? [ev("data", t.id, t.name, w, t.sourceId)] : [];
    });
  const bySection = (): EvidenceLink[] =>
    (m.doc?.sections ?? []).flatMap((s) => {
      if (!s.hasContent) return [];
      if (s.specKey && input.specKeys.includes(s.specKey)) return [ev("document", s.sectionId, s.heading)];
      const w = words.length ? firstMatch([s.heading], words) : undefined;
      return w ? [ev("document", s.sectionId, s.heading, w)] : [];
    });
  const byNotes = (): EvidenceLink[] => {
    if (!m.notes || !words.length) return [];
    const out: EvidenceLink[] = [];
    const w = firstMatch([m.notes.scratchpad], words);
    if (w) out.push(ev("note", "notes", "Notes", w));
    for (const s of m.notes.sections) {
      const sw = firstMatch([s.notes], words);
      if (sw) out.push(ev("note", s.sectionId, s.heading, sw));
    }
    return out;
  };
  switch (input.kind) {
    case "type":
      return m.doc?.typeKey ? [ev("document", "doc", m.doc.typeTitle ?? m.doc.typeKey)] : [];
    case "source":
      return bySource();
    case "data":
      return byData();
    case "section":
      return bySection();
    case "notes":
      return byNotes();
    case "any": {
      const found = [...bySource(), ...(words.length ? byData() : []), ...bySection(), ...byNotes()];
      if (found.length || !words.length || !m.doc) return found;
      const w = firstMatch([withoutTemplateLines(m.doc.text)], words);
      return w ? [ev("document", "doc", m.doc.title || "Document", w)] : [];
    }
  }
}

/** Pure: each input checked by keywords. */
export function keywordGate(inputs: GateInput[], m: GateMaterial): GateItem[] {
  return inputs.map((i) => {
    const evidence = keywordEvidence(i, m).slice(0, 6);
    return { key: i.key, label: i.label, required: i.required, present: evidence.length > 0, how: evidence.length ? "keyword" : "none", evidence, help: i.help };
  });
}

/** Pure: the report from the checked items. */
export function gateReport(items: GateItem[]): GateReport {
  return { items, missing: items.filter((i) => i.required && !i.present) };
}

export const GateModelOutput = z.object({
  inputs: z.array(z.object({ key: z.string(), present: z.boolean(), evidence: z.array(z.object({ id: z.string(), quote: z.string() })), why: z.string() })),
});
export type GateModelOutput = z.infer<typeof GateModelOutput>;

/** Pure: the fast-model check's user message. Only summaries, headings and the start of each section go in. */
export function gateUserPrompt(missing: GateInput[], m: GateMaterial): string {
  const out: string[] = [];
  out.push(["Inputs to check (key: label; what counts):", ...missing.map((i) => `- ${i.key}: ${i.label}${i.help ? `; ${i.help}` : ""}${i.match.length ? ` (cues: ${i.match.join(", ")})` : ""}`)].join("\n"));
  const sources = m.sources.map((s) => tagBlock("source", defuseAll(s.summary || "(no summary)"), { id: s.id, title: s.title, ...(s.role ? { role: s.role } : {}) }));
  out.push(tagBlock("sources", sources.join("\n") || "(no sources are linked)"));
  if (m.tables.length) out.push(tagBlock("data", m.tables.map((t) => tagBlock("table", defuseAll(t.columns.map((c) => c.label).join(", ")), { id: t.id, name: t.name })).join("\n")));
  if (m.doc) {
    const sections = m.doc.sections.map((s) => tagBlock("section", defuseAll(clip(withoutTemplateLines(s.text).trim(), 300) || "(empty)"), { id: s.sectionId, heading: s.heading }));
    out.push(tagBlock("document", sections.join("\n") || defuseAll(clip(withoutTemplateLines(m.doc.text).trim(), 1500) || "(empty)"), { title: m.doc.title || "Untitled" }));
  }
  out.push(notesBlock(m.notes));
  return out.join("\n\n");
}

/** Pure: apply the model's verdicts to the keyword misses. A "present" with no checkable evidence stays missing. */
export function applyGateReply(items: GateItem[], reply: GateModelOutput, index: EvidenceIndex): GateItem[] {
  const byKey = new Map(reply.inputs.map((r) => [r.key, r]));
  return items.map((it) => {
    if (it.present) return it;
    const r = byKey.get(it.key);
    if (!r?.present) return it;
    const evidence = index.links(r.evidence, "for");
    return evidence.length ? { ...it, present: true, how: "model" as const, evidence } : it;
  });
}

export const stepGate: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as { inputs: GateInput[]; useModel: boolean };
  const m: GateMaterial = { doc: asDoc(inputs.document), sources: asSources(inputs.sources)?.sources ?? [], tables: asTables(inputs.data), notes: asNotes(inputs.notes) };
  let items = keywordGate(config.inputs, m);
  const misses = config.inputs.filter((i, n) => !items[n].present && i.kind !== "type");
  if (config.useModel && misses.length) {
    const index = new EvidenceIndex({ doc: m.doc, sources: { sources: m.sources, passages: [] }, tables: m.tables, notes: m.notes });
    const { data } = await claudeJson({ task: "workflow.gate", system: GATE_SYSTEM, user: gateUserPrompt(misses, m), schema: GateModelOutput, ...callOpts(ctx) });
    items = applyGateReply(items, data, index);
  }
  const report = gateReport(items);
  return report.missing.length ? { blocked: report, report } : { pass: report, report };
};
