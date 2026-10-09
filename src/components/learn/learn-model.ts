// The learn-from-example dialog's state, pure and client-safe (PLAN §6.11,
// phase8-spec.md §3.3): which examples are picked (1–5), where each inferred
// part came from in an example (the highlights), the author's keep/remove
// decisions on copied text and keep decisions on flagged names, the draft's
// current validation, and when Save may be pressed. The dialog
// (learn-dialog.tsx) and the review (learn-review.tsx) render it.

import { parseDefinition, type DocumentTypeDefinition } from "@/catalog/schema";
import {
  draftValid,
  KEEPABLE_PERSONAL_KINDS,
  LEARN_MAX_EXAMPLES,
  type LearnDraft,
  type LearnExampleRef,
  type LearnedPart,
  type OverlapFlag,
  type PersonalDetailFlag,
  type SaveLearnedRequest,
} from "@/lib/learn/contract";
import { findOverlaps, removeOverlap } from "@/lib/learn/overlap";
import { isSectionKeyError, sectionKeyErrors } from "@/lib/learn/section-keys";

export const refId = (r: LearnExampleRef) => (r.kind === "source" ? `source:${r.sourceId}` : `document:${r.documentId}`);

/** Pick or unpick an example; no more than LEARN_MAX_EXAMPLES. */
export function togglePick(picked: LearnExampleRef[], ref: LearnExampleRef): LearnExampleRef[] {
  const id = refId(ref);
  if (picked.some((p) => refId(p) === id)) return picked.filter((p) => refId(p) !== id);
  return picked.length >= LEARN_MAX_EXAMPLES ? picked : [...picked, ref];
}

export const canLearn = (picked: LearnExampleRef[]) => picked.length >= 1 && picked.length <= LEARN_MAX_EXAMPLES;

/** What the progress line says while the extraction runs (it streams for a minute or more). */
export function progressLabel(elapsedMs: number, examples: number): string {
  const s = elapsedMs / 1000;
  if (s < 5) return `Reading ${examples === 1 ? "the example" : `${examples} examples`}…`;
  if (s < 60) return "Learning the outline, guidance and checks…";
  if (s < 150) return "Writing the workflow and requirements…";
  return "Checking the draft against the catalog's rules…";
}

// --- Highlights ------------------------------------------------------------------------

const normChar = (c: string) => (/\s/.test(c) ? " " : c.toLowerCase());

/**
 * Where `quote` appears in `text`, ignoring case and runs of whitespace, or
 * null. Returns offsets into `text`.
 */
export function findQuote(text: string, quote: string): [number, number] | null {
  const q = quote.trim().replace(/\s+/g, " ").toLowerCase();
  if (q.length < 3) return null;
  // Normalized text with a map back to the original offsets.
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = normChar(text[i]);
    if (c === " " && norm.endsWith(" ")) continue;
    norm += c;
    map.push(i);
  }
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

export type Segment = { text: string; parts: number[] };

/** The example's text split into plain and highlighted runs; each highlight lists the parts (indexes) whose quotes cover it. */
export function highlightSegments(text: string, parts: LearnedPart[], example: number): Segment[] {
  const ranges: Array<{ start: number; end: number; part: number }> = [];
  parts.forEach((p, i) => {
    for (const f of p.from) {
      if (f.example !== example || !f.quote) continue;
      const r = findQuote(text, f.quote);
      if (r) ranges.push({ start: r[0], end: r[1], part: i });
    }
  });
  if (!ranges.length) return [{ text, parts: [] }];
  const cuts = [...new Set([0, text.length, ...ranges.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const covering = ranges.filter((r) => r.start <= a && r.end >= b).map((r) => r.part);
    const seg = { text: text.slice(a, b), parts: [...new Set(covering)] };
    const last = out.at(-1);
    if (last && !last.parts.length && !seg.parts.length) last.text += seg.text;
    else out.push(seg);
  }
  return out;
}

// --- Review state ----------------------------------------------------------------------

export type Editable = Pick<LearnDraft, "type" | "workflow" | "requirementSets">;

export type ReviewState = {
  draft: Editable;
  /** Overlap paths the author keeps on purpose. */
  keep: string[];
  /** Include the workflow when saving (the author may save the type alone). */
  withWorkflow: boolean;
  /** The explicit checkpoint: "I reviewed this against the examples". */
  reviewed: boolean;
  /** The type was edited here; the server re-validates it on save. */
  edited: boolean;
  /**
   * The problems known for the current draft: the extraction's, then the save
   * route's (a 422), with the rules a type edit affects re-run on each edit.
   */
  validation: LearnDraft["validation"];
  /** Flagged names and organizations the author keeps on purpose (texts). */
  keepPersonal: string[];
};

export const initialReview = (d: LearnDraft): ReviewState => ({
  draft: { type: d.type, workflow: d.workflow, requirementSets: d.requirementSets },
  keep: [],
  withWorkflow: true,
  reviewed: false,
  edited: false,
  validation: d.validation,
  keepPersonal: [],
});

/**
 * "Edit the type" saved (already parsed): the type's own problems are gone,
 * and the workflow's section-key rule is run again against the new sections,
 * so a section put back clears its error and one removed adds one.
 */
export function applyTypeEdit(state: ReviewState, type: DocumentTypeDefinition): ReviewState {
  const steps = state.draft.workflow?.steps ?? [];
  const workflow = [...state.validation.workflow.filter((e) => !isSectionKeyError(e)), ...sectionKeyErrors(steps, type.sections)];
  return { ...state, draft: { ...state.draft, type }, edited: true, reviewed: false, validation: { ...state.validation, type: [], workflow } };
}

/**
 * How "Edit the type" opens: on the form when the type parses; otherwise in
 * the JSON editor with the draft's text, so a type the repair round could not
 * fix is fixed here (then applyTypeEdit) instead of by extracting again.
 */
export function typeEditorStart(type: unknown): { typeOk: boolean; initialJson?: string } {
  return parseDefinition(type).ok ? { typeOk: true } : { typeOk: false, initialJson: JSON.stringify(type, null, 2) };
}

/** The save route refused with validation: it becomes what the review shows and checks. */
export const withServerValidation = (state: ReviewState, validation: LearnDraft["validation"]): ReviewState => ({ ...state, validation });

/** "Keep": a flagged name or organization is not a person's (toggle); a pattern can't be kept. */
export function keepPersonalFlag(state: ReviewState, flag: PersonalDetailFlag): ReviewState {
  if (!KEEPABLE_PERSONAL_KINDS.has(flag.kind)) return state;
  const kept = state.keepPersonal.includes(flag.text);
  return { ...state, keepPersonal: kept ? state.keepPersonal.filter((k) => k !== flag.text) : [...state.keepPersonal, flag.text] };
}

/** The copied runs still in the draft (re-checked against the examples after every change). */
export const currentOverlaps = (state: ReviewState, examples: LearnDraft["examples"]): OverlapFlag[] => findOverlaps(state.draft, examples.map((e) => e.text));

/** "Remove": the run taken out of its field. */
export function removeFlag(state: ReviewState, flag: OverlapFlag): ReviewState {
  return { ...state, draft: removeOverlap(state.draft, flag), keep: state.keep.filter((k) => k !== flag.path), reviewed: false };
}

/** "Keep": the author keeps the copied run on purpose (toggle). */
export function keepFlag(state: ReviewState, flag: OverlapFlag): ReviewState {
  const kept = state.keep.includes(flag.path);
  return { ...state, keep: kept ? state.keep.filter((k) => k !== flag.path) : [...state.keep, flag.path] };
}

/**
 * Why Save is off, or null when it may be pressed: the draft must validate
 * (an edit is checked again by the server), every copied run is kept or
 * removed, and the author ticked the checkpoint.
 */
export function saveBlocker(state: ReviewState, d: Pick<LearnDraft, "examples">): string | null {
  const v = state.validation;
  const relevant = state.withWorkflow ? v : { ...v, workflow: [], graph: [] };
  if (!draftValid(relevant)) return "Fix the problems listed before saving.";
  const open = currentOverlaps(state, d.examples).filter((f) => !state.keep.includes(f.path));
  if (open.length) return `Keep or remove ${open.length === 1 ? "the copied passage" : `the ${open.length} copied passages`} first.`;
  if (!state.reviewed) return "Confirm you reviewed the draft against the examples.";
  return null;
}

export function saveRequest(state: ReviewState, d: Pick<LearnDraft, "examples" | "personalDetails">, documentId?: string | null): SaveLearnedRequest {
  // The extraction's flags go back as hints, so the save looks for what the model pointed out too.
  const hints = new Map(d.personalDetails.map((f) => [f.text, f.kind]));
  return {
    examples: d.examples.map((e) => e.ref),
    ...(documentId ? { documentId } : {}),
    type: state.draft.type,
    ...(state.withWorkflow ? { workflow: state.draft.workflow } : {}),
    requirementSets: state.draft.requirementSets,
    reviewed: true,
    keepOverlaps: state.keep,
    personalHints: [...hints].slice(0, 100).map(([text, kind]) => ({ text, kind })),
    keepPersonal: state.keepPersonal,
  };
}

/** The parts for one tab, by path prefix. */
export const partsFor = (parts: LearnedPart[], prefix: "type" | "workflow" | "requirements") => parts.map((p, i) => ({ part: p, index: i })).filter((x) => x.part.path.startsWith(`${prefix}.`));
