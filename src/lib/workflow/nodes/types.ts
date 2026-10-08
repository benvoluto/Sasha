// What the reader nodes hand to the review steps: a snapshot of the document
// (doc.read), its notes (doc.notes), its linked sources and passages
// (sources.list, sources.read), its data tables (data.list) and requirement
// sets (requirements.read), plus the shapes type.coverage, web.find and
// rubric.score emit. Plain JSON, so they survive the run record.
//
// CONTRACT (Phase 6): owned by the nodes-steps track; the generic nodes
// (src/lib/workflow/generic/) import these.

import type { Family, RubricCriterion, SectionSpec } from "@/catalog/schema";
import type { RequirementItem } from "@/catalog/requirements-schema";
import type { EvidenceLink, RequirementRef } from "../contract";

/** Characters of document text a snapshot keeps. */
export const MAX_DOC_TEXT = 200_000;

/** One heading's section, its own body only (listSections with `{own: true}`). */
export type SectionView = {
  /** The heading's stable sectionId ("s<index>" for a heading that has none). */
  sectionId: string;
  heading: string;
  level: number;
  specKey: string | null;
  /** Position of the heading among the document's top-level nodes. */
  index: number;
  /** The section's own body text, capped at doc.read's sectionChars. */
  text: string;
  wordCount: number;
  hasContent: boolean;
  /** The type section's renderer ("narrative" when the heading has no spec). */
  renderer: string;
  /** The type section's `required` (false when the heading has no spec). */
  required: boolean;
};

export type TypeSectionView = Pick<SectionSpec, "key" | "heading" | "level" | "required" | "guidance" | "lengthHint" | "elements" | "sourcesNeeded" | "dataNeeded" | "renderer">;

export type TypeView = { key: string; title: string; version: number; family: Family; sections: TypeSectionView[]; rubric: RubricCriterion[] };

/** `D`: the document output of doc.read. */
export type DocSnapshot = {
  id: string;
  title: string;
  typeKey: string | null;
  typeTitle: string | null;
  updatedAt: string;
  wordCount: number;
  /** The document's text, capped at MAX_DOC_TEXT. */
  text: string;
  /** Text before the first heading (capped like a section). */
  preamble: string;
  sections: SectionView[];
  type: TypeView | null;
};

export type NotesView = { scratchpad: string; sections: Array<{ sectionId: string; heading: string; notes: string }> };

export type SourceView = { id: string; title: string; kind: string; role: string | null; summary: string; status: string; url: string | null };
export type PassageView = { id: string; sourceId: string; page: number | null; text: string };
/** `S`: the sources output of sources.read. */
export type SourcesSnapshot = { sources: SourceView[]; passages: PassageView[] };

export type TableView = {
  id: string;
  name: string;
  sourceId: string;
  sourceTitle: string;
  columns: Array<{ key: string; label: string; type: string; unit: string | null }>;
  rowCount: number;
  rows: Array<Array<string | null>>;
};

export type RequirementItemView = Pick<RequirementItem, "title" | "kind" | "text" | "value" | "unit" | "appliesTo" | "citation"> & {
  /** "<set>#<item>". */
  ref: string;
};
export type RequirementsView = { sets: RequirementRef[]; items: RequirementItemView[] };

/** type.coverage: one need (a source, a data set or a required element) and how well the linked material supports it. */
export type CoverageRow = {
  need: string;
  kind: "source" | "data" | "element";
  specKey: string | null;
  heading: string | null;
  status: "supported" | "weak" | "missing";
  evidence: EvidenceLink[];
  note: string;
};

/** web.find: a public resource for a gap. Never verified until a person adds it. */
export type WebResource = { url: string; title: string; publisher: string; why: string; need: string; specKey: string | null; verified: false };

/** rubric.score: one criterion's level. */
export type RubricScore = { criterion: string; label: string; level: number; maxLevel: number; rationale: string; evidence: EvidenceLink[]; fix: string };
