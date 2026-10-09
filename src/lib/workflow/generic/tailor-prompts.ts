// Prompts for tailor.lines (After Phase 9, user decision 2026-10-09): the
// resume Tailor step. The system prompt is stable (role, rules, output) so it
// caches; the requirements, the resume's lines and the master history go in the
// user message inside delimited tags, broken up inside the material. Lines ride
// as [D12] refs and passages as [S….P3] ids, and the handler checks every one
// the model returns against what it was shown.

import { z } from "zod";
import { delimit } from "@/lib/sections/prompt";
import { TAILOR_LINE_ACTIONS, type ExtractedItem } from "../contract";
import type { DocLine } from "../lines";
import { defuseAll, itemsBlock, MATERIAL_LINE, sourcesBlock } from "../nodes/prompts";
import { fieldText } from "../nodes/util";
import type { SourcesSnapshot } from "../nodes/types";

export const TAILOR_SYSTEM = [
  "You tailor a candidate's resume to one target role, line by line, from the candidate's master resume or work history. The master history is the only source of facts; the job posting reaches you only as the list of requirements.",
  MATERIAL_LINE,
  "The resume arrives as lines in <document>, each with a ref such as [D12] and its section. The requirements arrive in <items role=\"requirements\">, each with how the master history meets it before tailoring. The master history arrives in <sources>, each passage with its id in square brackets.",
  "Rules:",
  "- Change only lines shown, naming each by its ref. One entry per line at most.",
  "- rewrite: give the line's new text. lead: a bullet (a line in a list) moves to the top of its list; give its text, unchanged when it only moves. Never lead a line outside a list. trim: the line is removed; text is empty. Never trim a header line (employer, job title, dates): the lines under it would read as the previous job's.",
  "- Lead with the evidence that matches a requirement. Use the posting's terms only where the master history shows that experience.",
  "- Keep every number exactly as the master has it, with its scale and qualifiers ($2K is not $2M; 3 is not 3+). Never add an employer, job title, date, degree, certification, skill or number the master passages do not state. Titles and dates stay as in the master.",
  "- The candidate's role, scope and seniority stay as the master states them: never turn contributed to, assisted or supported into led, managed or owned, never enlarge a team or a scope, and never make shared credit sole credit. The posting's terms never raise them.",
  "- Trim lines unrelated to any requirement only when the resume is long. Prefer a few strong changes to many small ones.",
  "- Leave gaps as gaps: never write a line for a requirement marked GAP, and never list a GAP in a line's requirements.",
  "- Every rewrite, and every lead whose text changes, cites the master passage ids it rests on in support, each with a short quote copied word for word from that passage. Cite only passage ids shown in <sources>.",
  "- Plain text only: no markdown, no citation markers or passage ids in the text.",
  "- reason: one sentence on the requirement the line surfaces, or why it is trimmed. requirements: the ids of the requirement items it serves.",
  'Return JSON: {"lines": [{"line": "D12", "action": "rewrite" | "lead" | "trim", "text": "…", "reason": "…", "requirements": ["I3"], "support": [{"id": "S1a2b3c4d.P3", "quote": "…"}]}]}. An empty list is a fine answer when nothing should change.',
].join("\n");

export const TailorReply = z.object({
  lines: z.array(
    z.object({
      /** The line's ref, e.g. "D12". */
      line: z.string(),
      action: z.enum(TAILOR_LINE_ACTIONS),
      /** The new line ("" for trim; the same text for a lead that only moves). */
      text: z.string(),
      reason: z.string(),
      /** Requirement item ids. */
      requirements: z.array(z.string()),
      support: z.array(z.object({ id: z.string(), quote: z.string() })),
    }),
  ),
});
export type TailorReply = z.infer<typeof TailorReply>;

/** How the before trace left a requirement, in words the model acts on. */
export function beforeStatus(status: string): string {
  if (status === "direct") return "direct evidence in the master";
  if (status === "adjacent") return "adjacent evidence in the master";
  if (status === "none") return "GAP: no evidence in the master; do not write a line for it";
  return status.replace(/_/g, " ");
}

/** The requirements with their before statuses, as an items block. */
export function requirementsBlock(requirements: Array<ExtractedItem & { status?: string }>): string {
  return itemsBlock(
    requirements.map((r) => ({
      id: r.id,
      fields: {
        requirement: fieldText(r.fields.requirement ?? Object.values(r.fields)[0] ?? ""),
        priority: fieldText(r.fields.priority ?? null),
        before: beforeStatus(r.status ?? "none"),
      },
      location: null,
      evidence: [],
    })),
    { role: "requirements" },
  );
}

/** The resume's lines as `[D12] (Experience) text`, one per line, in <document>. */
export function linesBlock(lines: DocLine[]): string {
  return delimit("document", defuseAll(lines.map((l) => `[${l.ref}] (${l.heading || "Untitled section"}) ${l.text}`).join("\n")), { kind: "resume lines" });
}

export function tailorUserPrompt(m: { requirements: Array<ExtractedItem & { status?: string }>; lines: DocLine[]; master: SourcesSnapshot; instructions: string; maxLines: number }): string {
  const out = [
    "Target role requirements:",
    requirementsBlock(m.requirements),
    "The resume's lines you may change:",
    linesBlock(m.lines),
    "The master history (the only source of facts):",
    sourcesBlock(m.master),
  ];
  if (m.instructions.trim()) out.push(`Instructions: ${m.instructions.trim()}`);
  out.push(`Propose at most ${m.maxLines} line changes.`);
  return out.join("\n\n");
}
