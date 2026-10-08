// Request and response shapes for Phase 4 suggestions (PLAN §6.4): suggested
// sources, data and web resources for a document. Client-safe (zod, types and
// pure helpers only).
//
// CONTRACT (Phase 4): see phase4-spec.md §4. Owned by the suggestions track;
// the notes-and-modal track (document modal) imports the types. Change a shape
// only with every consumer updated in the same change.

import { z } from "zod";

export const SUGGESTION_KINDS = ["source", "data", "web"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/**
 * Where a suggestion came from: the type's sourcesNeeded/dataNeeded, the notes,
 * (Phase 6) the coverage workflow, or the person ("user": added by hand, never
 * removed by regeneration).
 */
export const SUGGESTION_ORIGINS = ["type", "notes", "coverage", "user"] as const;
export type SuggestionOrigin = (typeof SUGGESTION_ORIGINS)[number];

export const SUGGESTION_STATES = ["open", "added", "dismissed"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

export type SuggestionRecord = {
  id: string;
  document_id: string;
  kind: SuggestionKind;
  label: string;
  reason: string;
  /** The type section key it serves (type origin), or null. */
  spec_ref: string | null;
  url: string | null;
  origin: SuggestionOrigin;
  state: SuggestionState;
  /** The linked source that satisfied it (state "added", kind source/web), or null. */
  source_id: string | null;
  /** The data table that satisfied it (state "added", kind data; Phase 5), or null. */
  data_table_id: string | null;
  created_at: string;
  updated_at: string;
};

export const MAX_SUGGESTION_LABEL = 200;
export const MAX_SUGGESTION_REASON = 500;

/**
 * Suggestions are matched by label, ignoring case, spacing and trailing
 * punctuation (as the organizer's sameItem did), within a kind. "web" folds
 * into "source" so a web resource and a source with the same name are one item.
 */
export function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.;:,!]+$/, "");
}

export function suggestionDedupeKey(kind: SuggestionKind, label: string): string {
  return `${kind === "data" ? "data" : "source"}:${normalizeLabel(label)}`;
}

export const sameSuggestion = (a: Pick<SuggestionRecord, "kind" | "label">, b: Pick<SuggestionRecord, "kind" | "label">) =>
  suggestionDedupeKey(a.kind, a.label) === suggestionDedupeKey(b.kind, b.label);

// --- Routes -------------------------------------------------------------------

/**
 * GET /api/documents/[id]/suggestions → every suggestion for the document
 * (all states; the UI filters), plus whether the inputs changed since the last
 * generation (type, notes, linked sources) so the pane can regenerate.
 */
export type SuggestionListResponse = {
  suggestions: SuggestionRecord[];
  /** Inputs changed since the last generation (or never generated). */
  stale: boolean;
  generated_at: string | null;
  /** The last generation failed (the list is from an earlier run). */
  error: string | null;
};

/** POST /api/documents/[id]/suggestions/generate */
export const SuggestionGenerateRequest = z.strictObject({
  /** Run even when the inputs are unchanged (the pane's "Refresh"); still rate-gated. */
  force: z.boolean().optional(),
});
export type SuggestionGenerateRequest = z.infer<typeof SuggestionGenerateRequest>;

/**
 * → 200 SuggestionListResponse & { ran: boolean }. `ran` is false when the inputs
 * were unchanged, Claude is not configured (type-driven items are still
 * written, uncovered by judgement), or the per-document gate (60 s) is closed;
 * that is not an error.
 */
export type SuggestionGenerateResponse = SuggestionListResponse & { ran: boolean };

/** PATCH /api/documents/[id]/suggestions/[suggestionId] — a state change. */
export const SuggestionActionRequest = z.strictObject({
  action: z.enum(["add", "dismiss", "restore"]),
  /** With "add" on a source/web suggestion: the source that was linked for it. */
  source_id: z.string().uuid().optional(),
  /** With "add" on a data suggestion: a data table linked to this document for it (Phase 5). */
  data_table_id: z.string().uuid().optional(),
});
export type SuggestionActionRequest = z.infer<typeof SuggestionActionRequest>;
export type SuggestionResponse = { suggestion: SuggestionRecord };

/** POST /api/documents/[id]/suggestions — the person adds their own item. */
export const SuggestionCreateRequest = z.strictObject({
  kind: z.enum(["source", "data"]),
  label: z.string().trim().min(1).max(MAX_SUGGESTION_LABEL),
  reason: z.string().trim().max(MAX_SUGGESTION_REASON).optional(),
});
export type SuggestionCreateRequest = z.infer<typeof SuggestionCreateRequest>;

// --- Add-source hand-off (Suggestions tab → Sources tab) ----------------------

/**
 * "Add" on a source or web suggestion opens the Sources tab with this. The
 * Sources panel shows "Adding for: <label>", opens the link form prefilled with
 * `url` when there is one (otherwise the library picker searching `label`),
 * and when a source gets linked while the prefill is active it marks the
 * suggestion added (PATCH action "add" with the source id).
 */
export type SourcePrefill = { suggestionId: string; label: string; url: string | null };

// --- Add-data hand-off (Suggestions tab → Data tab; Phase 5) --------------------

/**
 * "Add" on a data suggestion opens the Data tab with this. The Data pane shows
 * "Adding for: <label>", opens its table picker searching `label`, and when a
 * table gets linked while the prefill is active it marks the suggestion added
 * (PATCH action "add" with the table id).
 */
export type DataPrefill = { suggestionId: string; label: string };
