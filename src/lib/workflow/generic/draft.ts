// draft.section (phase6-spec.md §3): drafts one empty section from its notes,
// the scratchpad and the linked sources, sentence by sentence, each sentence
// carrying the passage or note behind it. Passage ids the model was not shown
// are dropped, and a sentence left with no support is marked unsourced (the
// editor highlights it). The change is a replace_section_body op with
// onlyIfEmpty, so a section someone filled in meanwhile is left alone.

import { buildGrounding, type Grounding } from "@/lib/sections/grounding";
import { claudeJson } from "@/lib/llm/claude";
import { stripCitationMarkers } from "@/lib/sections/content";
import { passagePrefix } from "@/lib/sources/pages";
import type { DocumentChangeOp, DraftedSection, EvidenceLink, SentenceTrace } from "../contract";
import type { NodeHandler } from "../context";
import { asDoc, asNotes, callOpts, clip, Findings, flat } from "../nodes/util";
import type { DocSnapshot, NotesView, SectionView } from "../nodes/types";
import { DRAFT_TRACED_SYSTEM, DraftTracedReply, draftTracedPrompt } from "./prompts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asSection = (v: unknown): SectionView | null => {
  const s = flat(v)[0];
  return isObj(s) && typeof s.sectionId === "string" && typeof s.heading === "string" ? (s as unknown as SectionView) : null;
};

/** Passage ids or citation markers the model put in the text anyway. */
const cleanSentence = (s: string) =>
  stripCitationMarkers(s.replace(/\s?\[S[0-9a-f]{8}\.P\d+\]/gi, ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

/**
 * Pure: the model's sentences checked against what it was shown. Passage
 * support must name a passage in the grounding; note support counts only when
 * there are notes. Markdown is the sentences joined into paragraphs.
 */
export function traceDraft(
  reply: DraftTracedReply,
  m: { grounding: Pick<Grounding, "sources" | "passages">; sectionId: string; sectionNotes: string; scratchpad: string },
): { trace: SentenceTrace[]; markdown: string; unsourced: number } {
  const sourceByPrefix = new Map(m.grounding.sources.map((s) => [passagePrefix(s.id), s]));
  const passages = new Map(m.grounding.passages.map((p) => [p.id, p]));
  const hasNotes = !!(m.sectionNotes.trim() || m.scratchpad.trim());
  const trace: SentenceTrace[] = [];
  const paragraphs: string[][] = [];
  for (const s of reply.sentences) {
    const text = cleanSentence(s.text);
    if (!text) continue;
    const support: EvidenceLink[] = [];
    const seen = new Set<string>();
    for (const ref of s.support) {
      if (ref.kind === "note") {
        if (!hasNotes || seen.has("note")) continue;
        seen.add("note");
        const own = !!m.sectionNotes.trim();
        support.push({ kind: "note", ref: own ? m.sectionId : "notes", sourceId: null, label: own ? "Section notes" : "Notes", quote: "", page: null, stance: "for", verified: true });
        continue;
      }
      const id = (ref.id ?? "").trim().replace(/^\[|\]$/g, "");
      const p = passages.get(id);
      if (!p || seen.has(id)) continue;
      seen.add(id);
      const src = sourceByPrefix.get(id.split(".")[0]);
      support.push({ kind: "passage", ref: p.id, sourceId: src?.id ?? null, label: clip(src?.title ?? "Source", 300), quote: clip(p.text, 300), page: p.page, stance: "for", verified: true });
    }
    trace.push({ text, support, unsourced: support.length === 0 });
    if (s.paragraph_break || !paragraphs.length) paragraphs.push([text]);
    else paragraphs[paragraphs.length - 1].push(text);
  }
  return { trace, markdown: paragraphs.map((p) => p.join(" ")).join("\n\n"), unsourced: trace.filter((t) => t.unsourced).length };
}

function sectionNotesFor(notes: NotesView | null, sectionId: string): string {
  return notes?.sections.find((s) => s.sectionId === sectionId)?.notes ?? "";
}

export const draftSectionHandler: NodeHandler = async (inputs, node, ctx) => {
  const section = asSection(inputs.section);
  const skip = { draft: null, op: null, findings: [] };
  if (!section) return skip;
  if ((node.config.skipStatic as boolean) !== false && section.renderer === "static") return skip;
  const doc: DocSnapshot | null = asDoc(inputs.document);
  const notes = asNotes(inputs.notes);
  const spec = doc?.type?.sections.find((s) => s.key === section.specKey) ?? null;
  const sectionNotes = sectionNotesFor(notes, section.sectionId);
  const scratchpad = notes?.scratchpad ?? "";

  const grounding = await buildGrounding(ctx.teamId, ctx.documentId, { focus: [section.heading, ...(spec?.elements ?? []), ...(spec?.sourcesNeeded ?? []), sectionNotes] });
  const { data } = await claudeJson({
    task: "draft.traced",
    system: DRAFT_TRACED_SYSTEM,
    user: draftTracedPrompt({
      title: doc?.title ?? "",
      typeTitle: doc?.typeTitle ?? null,
      heading: section.heading,
      spec,
      outline: (doc?.sections ?? []).map((s) => s.heading),
      scratchpad,
      sectionNotes,
      grounding: grounding.block,
    }),
    schema: DraftTracedReply,
    ...callOpts(ctx),
  });

  const { trace, markdown, unsourced } = traceDraft(data, { grounding, sectionId: section.sectionId, sectionNotes, scratchpad });
  const draft: DraftedSection = { sectionId: section.sectionId, specKey: section.specKey, heading: section.heading, level: section.level, markdown, trace, unsourced };
  // Nothing usable came back: no change for this section (the finding says so).
  const op: DocumentChangeOp | null = markdown ? { op: "replace_section_body", sectionId: section.sectionId, specKey: section.specKey, heading: section.heading, level: section.level, markdown, onlyIfEmpty: true, trace } : null;
  const findings = new Findings(node.node.id);
  const passages = trace.flatMap((t) => t.support.filter((e) => e.kind === "passage"));
  findings.add({
    kind: "draft_summary",
    severity: "info",
    status: unsourced ? "unsourced" : "sourced",
    title: !trace.length
      ? `“${clip(section.heading, 120)}”: nothing to draft from the notes and sources`
      : unsourced
        ? `“${clip(section.heading, 120)}”: ${unsourced} of ${trace.length} drafted sentences unsourced`
        : `“${clip(section.heading, 120)}”: every drafted sentence has a note or source`,
    detail: unsourced ? "Unsourced sentences are highlighted in the draft; check or remove them." : "",
    location: { sectionId: section.sectionId, specKey: section.specKey, heading: section.heading, quote: "" },
    evidence: [...new Map(passages.map((e) => [e.ref, e])).values()].slice(0, 12),
  });
  return { draft, op, findings: findings.list() };
};
