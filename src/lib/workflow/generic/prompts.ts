// Prompts for the generic model nodes (phase6-spec.md §4.1): planning a
// restructure, rewording a restructured section, and drafting a section with a
// trace for every sentence. Each system prompt is stable (role, rules, output
// format) so it caches; the document, its notes and its sources go in the user
// message inside delimited tags with those tags broken up inside the material.
// Ids ride in tag attributes and square brackets, and the handlers check every
// id the model returns against what it was shown.

import { z } from "zod";
import { delimit } from "@/lib/sections/prompt";
import type { SectionSpec } from "@/catalog/schema";
import { defuseAll, MATERIAL_LINE } from "../nodes/prompts";
import { clip } from "../nodes/util";
import type { RestructureChunk } from "../restructure";

/** Characters of each part's text shown to the planner. */
export const PLAN_PART_CHARS = 1200;
/** Characters of a section's moved text sent for rewording. */
export const REWRITE_CHARS = 40_000;

type TargetView = Pick<SectionSpec, "key" | "heading"> & Partial<Pick<SectionSpec, "guidance" | "elements">>;

const targetsBlock = (title: string, sections: TargetView[]) =>
  delimit(
    "outline",
    sections
      .map((s) => {
        const about = [s.guidance?.trim(), s.elements?.length ? `Covers: ${s.elements.join("; ")}` : ""].filter(Boolean).join(" ");
        return `- key "${s.key}": ${s.heading}${about ? ` — ${clip(about, 400)}` : ""}`;
      })
      .join("\n"),
    { type: title },
  );

// --- restructure.plan --------------------------------------------------------------

export const RESTRUCTURE_PLAN_SYSTEM = [
  "You map the parts of an existing document onto the sections of a target document type, so the text can be moved word for word into the target's outline.",
  MATERIAL_LINE,
  "The document arrives as <part> blocks, each with an id (R1, R2…) and its own heading (or none, for the text before the first heading). The target outline lists each section's key, heading and what it covers.",
  "Rules:",
  "- Give every part exactly one target: the key of the section where its text belongs, or null when no section is a good home. A part with no home is kept, word for word, under “Content to place”; prefer null to a forced fit.",
  "- Several parts may go to one section. Use only keys from the outline, exactly as written.",
  "- Judge by what the text says, not only its heading.",
  "- Give a short reason (one sentence) for each target.",
  'Return JSON: {"rows": [{"id": "R1", "target": "<section key>" | null, "reason": "…"}]}, one row per part, in order.',
].join("\n");

export const RestructurePlanReply = z.object({
  rows: z.array(z.object({ id: z.string(), target: z.string().nullable(), reason: z.string() })),
});
export type RestructurePlanReply = z.infer<typeof RestructurePlanReply>;

export function restructurePlanPrompt(m: { title: string; targetTitle: string; sections: TargetView[]; chunks: RestructureChunk[] }): string {
  const parts = m.chunks.map((c, i) =>
    delimit("part", defuseAll(clip(c.text, PLAN_PART_CHARS) || "(no text)"), { id: `R${i + 1}`, heading: c.heading ?? "(before the first heading)" }),
  );
  return [
    `Target type: ${m.targetTitle}`,
    targetsBlock(m.targetTitle, m.sections),
    delimit("document", parts.join("\n") || "(the document is empty)", { title: m.title || "Untitled" }),
    "Map every part.",
  ].join("\n\n");
}

// --- restructure.rewrite ------------------------------------------------------------------

export const RESTRUCTURE_REWRITE_SYSTEM = [
  "You reword one section of a document that has just been restructured: its text was moved, word for word, from several places into this section, so it may read as pieces.",
  MATERIAL_LINE,
  "Rules:",
  "- Keep every fact, figure, name, date, citation and claim in the section. Remove nothing of substance.",
  "- Add only transitional prose: connecting phrases and short linking sentences that make the pieces read as one section.",
  "- Never add a claim, figure, example or source that is not already in the section.",
  "- Keep it about the same length; reorder sentences only where that helps it read in order.",
  "Return Markdown for the section BODY only: no heading, no code fences, ### for any sub-headings.",
].join("\n");

export function restructureRewritePrompt(m: { heading: string; text: string; targetTitle: string; spec: TargetView | null }): string {
  const about = m.spec ? [m.spec.guidance?.trim(), m.spec.elements?.length ? `Covers: ${m.spec.elements.join("; ")}` : ""].filter(Boolean).join(" ") : "";
  return [
    `Document type: ${m.targetTitle}`,
    `Section: ${m.heading}${about ? `\nWhat the section covers: ${clip(about, 800)}` : ""}`,
    delimit("document", delimit("section", defuseAll(clip(m.text, REWRITE_CHARS)), { heading: m.heading }), {}),
    "Reword the section as instructed.",
  ].join("\n\n");
}

// --- draft.section ------------------------------------------------------------------------------

export const DRAFT_TRACED_SYSTEM = [
  "You draft one empty section of a document from the writer's notes and the linked sources, sentence by sentence, saying what supports each sentence.",
  MATERIAL_LINE,
  "Rules:",
  "- Ground every sentence in the notes or in a source passage. Do not invent figures, dates, names or facts; where the material is silent, write less rather than guess.",
  "- For each sentence, list its support: {\"kind\": \"passage\", \"id\": \"<passage id>\"} for a passage (ids are the ones in square brackets inside <sources>, copied exactly), or {\"kind\": \"note\", \"id\": null} when it rests on the notes. A sentence with no support gets an empty list; keep those few.",
  "- Do not put passage ids or citation markers in the sentence text.",
  "- Write plain sentences, no headings or lists. Set paragraph_break to true on the first sentence of each new paragraph after the first.",
  "- Follow the section's guidance and cover its required elements where the material allows.",
  'Return JSON: {"sentences": [{"text": "…", "support": [{"kind": "passage", "id": "S1a2b3c4d.P3"}], "paragraph_break": false}]}.',
].join("\n");

export const DraftTracedReply = z.object({
  sentences: z.array(
    z.object({
      text: z.string(),
      support: z.array(z.object({ kind: z.enum(["passage", "note"]), id: z.string().nullable() })),
      paragraph_break: z.boolean(),
    }),
  ),
});
export type DraftTracedReply = z.infer<typeof DraftTracedReply>;

export function draftTracedPrompt(m: {
  title: string;
  typeTitle: string | null;
  heading: string;
  spec: (TargetView & Partial<Pick<SectionSpec, "lengthHint">>) | null;
  outline: string[];
  scratchpad: string;
  sectionNotes: string;
  grounding: string;
}): string {
  const guide = m.spec
    ? [m.spec.guidance?.trim() ? `Guidance: ${m.spec.guidance.trim()}` : "", m.spec.elements?.length ? `Required elements: ${m.spec.elements.join("; ")}` : "", m.spec.lengthHint ? `Length: ${m.spec.lengthHint}` : ""].filter(Boolean).join("\n")
    : "";
  const notes = [m.sectionNotes.trim() ? delimit("note", defuseAll(m.sectionNotes.trim()), { for: m.heading }) : "", m.scratchpad.trim() ? delimit("note", defuseAll(m.scratchpad.trim()), { for: "the whole document" }) : ""].filter(Boolean).join("\n");
  return [
    `Document: ${m.title || "Untitled"}${m.typeTitle ? ` (${m.typeTitle})` : ""}`,
    `Outline: ${m.outline.join(" · ")}`,
    `Section to draft: ${m.heading}${guide ? `\n${guide}` : ""}`,
    delimit("notes", notes || "(no notes)"),
    m.grounding,
    "Draft the section.",
  ].join("\n\n");
}
