// Drafting and rewriting one section of a document with Claude (PLAN §4.5).
//
// The editor sends the section as it is on screen (heading, level, specKey,
// body) because the stored document may lag by an autosave; the server reads
// the rest itself: the document's type and the section's spec, the
// neighbouring sections for continuity, the stored notes and the linked
// sources. The reply is the section body as Markdown. Nothing here writes the
// document body: the editor inserts the result as one undoable transaction
// (after taking a document_version snapshot), so generation can't race
// autosave. Only the section's metadata row is updated (status "drafted").
//
// Model errors are not swallowed: a refusal or cut-off reply
// (ModelRefusalError / ModelTruncatedError) and any other failure propagate to
// the route, which maps them to 422 / 502.

import { getType } from "@/catalog";
import { CITE_SOURCES_INSTRUCTION, type CitationReport } from "@/lib/citations/contract";
import { groundingResolver, verifyMarkers, wordingChanged, WORDING_CHANGED_ERROR } from "@/lib/citations/verify";
import type { DocumentTypeDefinition, SectionSpec } from "@/catalog/schema";
import { getSectionMeta, markSectionGenerated } from "@/lib/documents/section-store";
import { listSections, type SectionInfo } from "@/lib/documents/sections";
import { getDocument } from "@/lib/documents/store";
import { claudeConfigured, claudeText } from "@/lib/llm/claude";
import type { Task } from "@/lib/llm/tasks";
import type { SectionGenerateRequest, SectionGenerateResponse, SectionMode } from "./contract";
import { buildGrounding } from "./grounding";
import { stripFences, systemPrompt, userPrompt, type Neighbour, type OutlineLine } from "./prompt";

/** The task (model tier and effort) each mode runs. */
export const MODE_TASKS: Record<SectionMode, Task> = {
  draft: "draft.section",
  rewrite: "rewrite.section",
  draft_from_notes: "draft.from_notes",
  rewrite_from_notes: "draft.from_notes",
};

export const taskForMode = (mode: SectionMode): Task => MODE_TASKS[mode];

const DRAFT_MODES: SectionMode[] = ["draft", "draft_from_notes"];
const NOTES_MODES: SectionMode[] = ["draft_from_notes", "rewrite_from_notes"];

/** A request the route answers with an error status rather than a model call. */
export type GenerateFailure =
  | { ok: false; code: "not_found"; status: 404; error: string }
  | { ok: false; code: "static"; status: 409; error: string }
  | { ok: false; code: "not_configured"; status: 503; error: string }
  | { ok: false; code: "notes_required"; status: 400; error: string }
  | { ok: false; code: "wording_changed"; status: 422; error: string };

export type GenerateResult = { ok: true; response: SectionGenerateResponse } | GenerateFailure;

export const STATIC_SECTION_ERROR = "This section is fixed text; edit it directly.";

/** The request after zod parsing (defaults applied). */
export type ParsedGenerateRequest = Omit<SectionGenerateRequest, "level" | "body"> & { level: number; body: string };

export type GenerateInput = {
  teamId: string;
  agent: string;
  documentId: string;
  sectionId: string;
  req: ParsedGenerateRequest;
};

/** The section's spec in the type, when it names one the type has. `pack:*` renderers are drafted as narrative. */
export function specFor(def: DocumentTypeDefinition | null, specKey: string | null | undefined): SectionSpec | null {
  if (!def || !specKey) return null;
  return def.sections.find((s) => s.key === specKey) ?? null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Index of the target in the stored sections: by sectionId, else by heading text. -1 when the stored copy doesn't have it yet. */
export function findTarget(sections: SectionInfo[], sectionId: string, heading: string): number {
  const byId = sections.findIndex((s) => s.sectionId === sectionId);
  if (byId >= 0) return byId;
  const h = norm(heading);
  return sections.findIndex((s) => norm(s.heading) === h);
}

/** Outline lines with the target marked; a target the stored copy lacks is appended. */
export function outlineLines(sections: SectionInfo[], target: number, heading: string, level: number): OutlineLine[] {
  const lines = sections.map((s, i) => ({ heading: s.heading, level: s.level, target: i === target }));
  if (target < 0) lines.push({ heading, level, target: true });
  return lines;
}

export function neighboursOf(sections: SectionInfo[], target: number): { previous: Neighbour; next: Neighbour } {
  if (target < 0) return { previous: null, next: null };
  const prev = sections[target - 1];
  const next = sections[target + 1];
  return {
    previous: prev ? { heading: prev.heading, text: prev.bodyText } : null,
    next: next ? { heading: next.heading, text: next.bodyText } : null,
  };
}

/** Drop a first line that repeats the section heading (the model is told not to, but sometimes does). */
export function dropRepeatedHeading(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const first = lines[0]?.replace(/^#{1,6}\s+/, "").replace(/^\*\*(.*)\*\*$/, "$1") ?? "";
  if (lines.length && /^(#{1,6}\s+|\*\*)/.test(lines[0]) && norm(first) === norm(heading)) return lines.slice(1).join("\n").trim();
  return markdown;
}

export async function generateSection({ teamId, agent, documentId, sectionId, req }: GenerateInput): Promise<GenerateResult> {
  if (!claudeConfigured()) return { ok: false, code: "not_configured", status: 503, error: "Claude is not configured." };
  const doc = await getDocument(teamId, documentId);
  if (!doc) return { ok: false, code: "not_found", status: 404, error: "Document not found." };

  const def = (await getType(teamId, doc.type_key))?.definition ?? null;
  const spec = specFor(def, req.specKey);
  if (spec?.renderer === "static" && DRAFT_MODES.includes(req.mode)) return { ok: false, code: "static", status: 409, error: STATIC_SECTION_ERROR };

  let notes = req.notes ?? "";
  if (req.notes === undefined) notes = (await getSectionMeta(teamId, documentId, sectionId))?.notes ?? "";
  if (NOTES_MODES.includes(req.mode) && !notes.trim()) {
    return { ok: false, code: "notes_required", status: 400, error: "This section has no notes to work from." };
  }

  // Own bodies, as the editor reads them, so a neighbour is that section's text and not its sub-sections'.
  const sections = listSections(doc.content_json, { own: true });
  const target = findTarget(sections, sectionId, req.heading);
  const grounding = await buildGrounding(teamId, documentId, {
    focus: [req.heading, ...(spec?.elements ?? []), ...(spec?.sourcesNeeded ?? []), ...(spec?.dataNeeded ?? []), notes],
  });

  const task = taskForMode(req.mode);
  const system = systemPrompt(def, req.mode);
  const user = userPrompt({
    doc: { title: doc.title, outline: outlineLines(sections, target, req.heading, req.level) },
    def,
    spec,
    req,
    notes,
    neighbours: neighboursOf(sections, target),
    grounding: grounding.block,
  });

  const { text } = await claudeText({ task, system, user, agent, documentId });
  const reply = dropRepeatedHeading(stripFences(text), req.heading);
  if (!reply) throw new Error("The model returned an empty section.");
  const { markdown, report } = await verifyMarkers(reply, groundingResolver(teamId, documentId, grounding));
  logCitations(report);
  // "Cite sources" may only add markers: a reply that rewords the body is refused, not applied.
  if (isCiteSources(req) && wordingChanged(req.body, markdown)) return { ok: false, code: "wording_changed", status: 422, error: WORDING_CHANGED_ERROR };

  const section = await markSectionGenerated(teamId, documentId, sectionId, spec?.key ?? req.specKey ?? null);
  if (!section) return { ok: false, code: "not_found", status: 404, error: "Document not found." };
  return { ok: true, response: { markdown, ...(spec?.renderer === "static" ? { lineBreaks: true } : {}), task, sourcesUsed: grounding.sources.length, section, citations: report } };
}

/** The section menu's "Cite sources": a rewrite whose instruction is the constant. */
export const isCiteSources = (req: { mode?: SectionMode; instruction?: string }) => (req.mode === undefined || req.mode === "rewrite") && req.instruction?.trim() === CITE_SOURCES_INSTRUCTION;

/** Counts only (never text): how many markers a reply kept and dropped. */
export function logCitations(report: CitationReport) {
  if (report.kept || report.dropped.length) console.info("[citations]", { kept: report.kept, dropped: report.dropped.length });
}
