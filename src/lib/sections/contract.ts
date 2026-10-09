// Request and response shapes for the Phase 3 section, outline and catalog
// routes. Client-safe (zod and types only): the routes parse requests with
// these schemas and the editor builds requests from the same types.
//
// CONTRACT (Phase 3): see the spec (phase3-spec.md §5). Owned by the
// generation-backend track; the editor-ui and catalog-pipeline tracks import it.
// Change a shape only with every consumer updated in the same change.

import { z } from "zod";
import { REWRITE_PRESETS } from "@/lib/report/rewrite-presets";
import { DocumentTypeDefinition, Family, TypeKey, type DocumentTypeSummary, type TypeOrigin } from "@/catalog/schema";
import type { CitationReport } from "@/lib/citations/contract";

// --- Section metadata (document_section) ------------------------------------

export const SECTION_STATUSES = ["empty", "drafted", "edited", "reviewed"] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/** A section id as the editor makes it (s_ + 8 chars); older or pasted ids may differ, so the rule is loose. */
export const SectionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export type SectionMeta = {
  section_id: string;
  spec_key: string | null;
  notes: string;
  status: SectionStatus;
  last_generated_at: string | null;
  updated_at: string;
};

export const MAX_SECTION_NOTES = 50_000;

/** PUT /api/documents/[id]/sections/[sectionId] */
export const SectionNotesPut = z.strictObject({
  notes: z.string().max(MAX_SECTION_NOTES),
  specKey: z.string().max(80).nullable().optional(),
});
export type SectionNotesPut = z.infer<typeof SectionNotesPut>;

/** GET /api/documents/[id]/sections → every stored row for the document. */
export type SectionListResponse = { sections: SectionMeta[] };
/** GET and PUT /api/documents/[id]/sections/[sectionId]. GET of a section with no row returns a blank meta (status "empty", notes ""), not 404. */
export type SectionResponse = { section: SectionMeta };

// --- Section generation ------------------------------------------------------

export const SECTION_MODES = ["draft", "rewrite", "draft_from_notes", "rewrite_from_notes"] as const;
export type SectionMode = (typeof SECTION_MODES)[number];

export const PresetKey = z.string().refine((k) => Object.prototype.hasOwnProperty.call(REWRITE_PRESETS, k), "unknown preset");

/**
 * POST /api/documents/[id]/sections/[sectionId]/generate
 *
 * The client sends the section as it is in the editor now (heading text,
 * level, specKey, body as Markdown-ish plain text), because the stored
 * content_json may lag the editor by an autosave. The server reads the rest
 * (type, neighbouring sections, stored notes, linked sources) itself.
 */
export const SectionGenerateRequest = z
  .strictObject({
    mode: z.enum(SECTION_MODES),
    heading: z.string().trim().min(1).max(500),
    level: z.number().int().min(1).max(6).default(2),
    specKey: z.string().max(80).nullable().optional(),
    /** Current section body as plain text (blocks joined by blank lines). Required for the rewrite modes. */
    body: z.string().max(100_000).default(""),
    /** Rewrite modes: one preset, or a freeform instruction, or both. */
    preset: PresetKey.optional(),
    direction: z.enum(["more", "less"]).optional(),
    instruction: z.string().trim().max(2000).optional(),
    /** Notes modes: the panel's current text (saves a round trip and avoids a stale read). Falls back to the stored notes. */
    notes: z.string().max(MAX_SECTION_NOTES).optional(),
  })
  .superRefine((r, ctx) => {
    if ((r.mode === "rewrite" || r.mode === "rewrite_from_notes") && !r.body.trim()) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "Nothing to rewrite: the section is empty." });
    }
    if (r.mode === "rewrite" && !r.preset && !r.instruction) {
      ctx.addIssue({ code: "custom", path: ["preset"], message: "Choose a preset or write an instruction." });
    }
  });
export type SectionGenerateRequest = z.input<typeof SectionGenerateRequest>;

export type SectionGenerateResponse = {
  /** Section body only, as Markdown. Convert with sectionBlocksFromMarkdown (src/lib/sections/content.ts). */
  markdown: string;
  /** True for a fixed (static) section: keep each line as its own line when converting (sectionBlocksFromMarkdown's `lineBreaks`). */
  lineBreaks?: boolean;
  /** The task that ran, for display/debug ("draft.section", "rewrite.section", "draft.from_notes"). */
  task: string;
  /** How many linked sources fed the prompt. 0 means the model had only the document and notes. */
  sourcesUsed: number;
  /** The section row after the run (status "drafted", last_generated_at set). */
  section: SectionMeta;
  /**
   * Phase 7: the markers left in `markdown` (each a verified bare [[p:ID]]) and
   * the ones dropped. Pass it to sectionBlocksFromMarkdown as `citations` to
   * turn the markers into citation marks. Absent from older servers: markers
   * are then stripped.
   */
  citations?: CitationReport;
};

/** Which mode the notes panel's action button runs (PLAN §4.5). null hides the button. */
export function notesActionMode(bodyText: string, notes: string): Extract<SectionMode, "draft_from_notes" | "rewrite_from_notes"> | null {
  if (!notes.trim()) return null;
  return bodyText.trim() ? "rewrite_from_notes" : "draft_from_notes";
}

// --- Living outline ----------------------------------------------------------

export const ELEMENT_STATUSES = ["missing", "partial", "done", "unknown"] as const;
export type ElementStatus = (typeof ELEMENT_STATUSES)[number];

/** POST /api/documents/[id]/outline-status. Runs against the stored (saved) document. */
export const OutlineStatusRequest = z.strictObject({
  /** Recompute even when the cached result matches the current content. */
  force: z.boolean().optional(),
});

export type OutlineSectionStatus = {
  specKey: string;
  heading: string;
  required: boolean;
  /** The heading that carries this specKey, if the document has one. */
  sectionId: string | null;
  present: boolean;
  /** Body has any text. */
  hasContent: boolean;
  elements: Array<{ element: string; status: ElementStatus }>;
};

export type OutlineStatusResponse = {
  /** null when the document has no type (sections is then []). */
  typeKey: string | null;
  typeVersion: number | null;
  /** sha256 of content_text + type key/version; unchanged hash = cached result. */
  contentHash: string;
  computedAt: string;
  /** false when element statuses are "unknown" because Claude is not configured or the call failed. */
  model: boolean;
  sections: OutlineSectionStatus[];
  /** Headings in the document with no specKey or a specKey the type doesn't have (shown under "Other sections"). */
  extraSections: Array<{ sectionId: string; heading: string; level: number }>;
};

// --- Catalog ----------------------------------------------------------------

/** GET /api/document-types?all=1 → { types } ; `all` (admin, settings:write) includes disabled types. */
export type DocumentTypesResponse = { types: DocumentTypeSummary[] };

/** GET /api/document-types/[key] */
export type DocumentTypeResponse = {
  type: DocumentTypeDefinition;
  meta: { origin: TypeOrigin; enabled: boolean; overridden: boolean; updated_at: string | null; editable: boolean };
};

/** POST /api/document-types : create a team type from a full definition (admin page "New type", JSON editor). */
export const CreateTypeRequest = z.strictObject({ definition: DocumentTypeDefinition });

/** PUT /api/document-types/[key] : replace the team's definition (for a file type, creates/updates the override). The key in the body must equal the path key. */
export const UpdateTypeRequest = z.strictObject({ definition: DocumentTypeDefinition });

/** PATCH /api/document-types/[key] */
export const EnableTypeRequest = z.strictObject({ enabled: z.boolean() });

/** POST /api/document-types/from-document : "Save outline as type". */
export const SaveOutlineAsTypeRequest = z.strictObject({
  documentId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  /** Optional; derived from the title (and made unique) when omitted. */
  key: TypeKey.optional(),
  family: Family.optional(),
  summary: z.string().trim().max(1000).optional(),
});

/** Response of POST /api/document-types/from-document. The client sets the document's type_key and stamps `specKeys` onto the matching headings (by sectionId) in one transaction. */
export type SaveOutlineAsTypeResponse = {
  type: DocumentTypeSummary;
  specKeys: Record<string, string>;
};
