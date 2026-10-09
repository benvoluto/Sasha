// Learn from an example (PLAN §6.11, phase8-spec.md §4): request and response
// shapes for extracting a document type (skill) and a workflow from one or more
// example documents, the author checkpoint that saves them as a team type and a
// team workflow, and the evaluation harness's report.
//
// Client-safe (zod and types only): the routes parse requests with these
// schemas, the review screen builds requests from the same types, and the
// evaluation script (scripts/learn/evaluate.ts) writes an EvalReport.
//
// CONTRACT (Phase 8): owned by the learn track. Shape changes go through the spec.

import { z } from "zod";
import { DocumentTypeDefinition, Family, type DocumentTypeSummary } from "@/catalog/schema";
import { WorkflowDefinition } from "@/catalog/workflow-schema";
import { RequirementSet } from "@/catalog/requirements-schema";

/** At most this many examples per extraction (they all go to one Opus call as delimited data). */
export const LEARN_MAX_EXAMPLES = 5;
/** Example text sent to the model is capped per example and in total (characters). */
export const LEARN_MAX_EXAMPLE_CHARS = 120_000;
export const LEARN_MAX_TOTAL_CHARS = 300_000;
/** A run of at least this many consecutive words shared with an example is flagged as copied. */
export const OVERLAP_MIN_WORDS = 12;
/** At most this many inferred requirement sets per learned workflow. */
export const LEARN_MAX_REQUIREMENT_SETS = 4;
/** Extraction is costly: per-team cap an hour, the limiter's default team window for "learn" (src/lib/limits/contract.ts). */
export const LEARN_TEAM_HOURLY_LIMIT = 6;
/** Shown with every inferred requirement set (the review, availability and the requirements.read step). */
export const LEARN_INFERRED_LABEL = "Inferred from examples, not from the rules";
/** Keys of team-scoped (inferred) requirement sets start with this, so they never collide with catalog sets. */
export const TEAM_REQUIREMENT_SET_PREFIX = "team-";

/** An example: a source in the library (an uploaded or linked example), or a document in Sasha (e.g. the current one). */
export const LearnExampleRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("document"), documentId: z.string().uuid() }),
]);
export type LearnExampleRef = z.infer<typeof LearnExampleRef>;

/** POST /api/document-types/learn : extract a draft type and workflow. Nothing is saved. */
export const LearnRequest = z.strictObject({
  examples: z.array(LearnExampleRef).min(1).max(LEARN_MAX_EXAMPLES),
  /** The document the author started from (document modal entry); used only for context and the return link. */
  documentId: z.string().uuid().optional(),
  /** Suggested name and family; the model proposes them when omitted. */
  title: z.string().trim().min(1).max(120).optional(),
  family: Family.optional(),
  /** What the author wants the type for, in their words (delimited as author input, not example text). */
  note: z.string().trim().max(2000).optional(),
});
export type LearnRequest = z.infer<typeof LearnRequest>;

export type LearnConfidence = "low" | "medium" | "high";

/** One example as the review screen shows it (left pane). Text is the team's own source; it never leaves the team. */
export type LearnExampleView = {
  /** Position in the request (0-based); InferenceOrigin.example points here. */
  index: number;
  ref: LearnExampleRef;
  title: string;
  words: number;
  /** The example's own headings in order (level, text), for the structure comparison. */
  headings: Array<{ level: number; text: string }>;
  /** Plain text as read (capped at LEARN_MAX_EXAMPLE_CHARS), so the review can highlight where things came from. */
  text: string;
  truncated: boolean;
};

/** Where one inferred part came from in an example. `quote` is a short locator (≤ 200 chars) for highlighting, never stored in the type. */
export type InferenceOrigin = { example: number; heading: string | null; quote: string | null };

/**
 * What was inferred from where (the "what was inferred from where" column of
 * the review). `path` names the part of the draft:
 *   "type.sections.<key>", "type.sections.<key>.guidance", "type.rubric.<key>",
 *   "type.signals", "type.preamble", "workflow.steps.<id>", "workflow.outcome",
 *   "requirements.<setKey>.<itemKey>".
 */
export type LearnedPart = {
  path: string;
  /** What the model inferred, in one line. */
  note: string;
  from: InferenceOrigin[];
  /** With 2+ examples: true when every example shows it. Always true for a single example. */
  shared: boolean;
};

/** A long run of words copied from an example into the draft (guidance must describe patterns, not copy sentences). */
export type OverlapFlag = {
  /** Draft path as in LearnedPart.path, plus the field ("type.sections.methods.guidance"). */
  path: string;
  /** The copied run as it appears in the draft. */
  text: string;
  words: number;
  example: number;
};

export const PERSONAL_DETAIL_KINDS = ["name", "email", "phone", "address", "date_of_birth", "id_number", "organization", "other"] as const;
export type PersonalDetailKind = (typeof PERSONAL_DETAIL_KINDS)[number];
/** Kinds an author may keep on purpose (a test or a public figure read as a name); patterns always block. */
export const KEEPABLE_PERSONAL_KINDS: ReadonlySet<PersonalDetailKind> = new Set(["name", "organization"]);

/** A personal detail found in the draft (from the examples). Removed details are replaced by a neutral placeholder. */
export type PersonalDetailFlag = { path: string; text: string; kind: PersonalDetailKind; removed: boolean };

/** Where 2+ examples differ (the draft keeps what they share). */
export type ExampleDifference = {
  aspect: "section" | "order" | "length" | "element" | "check" | "tone" | "other";
  description: string;
  /** Example indexes that have the variant described. */
  examples: number[];
};

/**
 * The extraction result shown at the author checkpoint. `type`, `workflow` and
 * `requirementSets` are already validated (parseDefinition,
 * parseWorkflowDefinition + compileWorkflow + validateGraph, parseRequirementSet);
 * a draft that fails validation after one repair attempt is returned with
 * `validation` filled in and cannot be saved until fixed.
 */
export type LearnDraft = {
  examples: LearnExampleView[];
  confidence: LearnConfidence;
  /** e.g. "One example: structure only, low confidence." */
  confidenceReason: string;
  /** Team type draft: provenance { source: "Learned from N example(s)", url: "", license: "Team", retrieved: today }. */
  type: DocumentTypeDefinition;
  /** Built only from existing shared-step nodes; kind "type", appliesTo [type.key]. */
  workflow: WorkflowDefinition;
  /** Inferred requirement sets (inferred: true, provenance.url ""). */
  requirementSets: RequirementSet[];
  parts: LearnedPart[];
  overlaps: OverlapFlag[];
  personalDetails: PersonalDetailFlag[];
  differences: ExampleDifference[];
  /** The closest catalog type (for the comparison and the evaluation), or null. */
  nearestType: { key: string; title: string; reason: string } | null;
  validation: { type: string[]; workflow: string[]; graph: string[]; requirementSets: string[] };
};

export type LearnResponse = { draft: LearnDraft };

/**
 * POST /api/document-types/learn/save : the author checkpoint. The server
 * re-validates everything, re-runs the overlap and personal-detail checks
 * against the examples, and refuses (422 with the flags) while either finds
 * something not acknowledged. The type is saved through createTeamType; the
 * workflow is compiled and saved as a team workflow bound to the type; inferred
 * requirement sets are saved team-scoped.
 */
export const SaveLearnedRequest = z.strictObject({
  examples: z.array(LearnExampleRef).min(1).max(LEARN_MAX_EXAMPLES),
  documentId: z.string().uuid().optional(),
  type: DocumentTypeDefinition,
  /** Omitted: save the type only. */
  workflow: WorkflowDefinition.optional(),
  requirementSets: z.array(RequirementSet).max(LEARN_MAX_REQUIREMENT_SETS).default([]),
  /** The author confirms they reviewed the draft against the examples. */
  reviewed: z.literal(true),
  /** Overlap flags the author chose to keep (paths); anything else flagged blocks the save. */
  keepOverlaps: z.array(z.string().max(300)).max(50).default([]),
  /** The extraction's personal-detail flags, sent back so the save checks them again (each must still appear in an example). */
  personalHints: z.array(z.object({ text: z.string().max(300), kind: z.enum(PERSONAL_DETAIL_KINDS) })).max(100).default([]),
  /** Names and organizations the author keeps on purpose (a test or a public figure read as a name); patterns can't be kept. */
  keepPersonal: z.array(z.string().max(300)).max(50).default([]),
});
export type SaveLearnedRequest = z.infer<typeof SaveLearnedRequest>;

export type SaveLearnedResponse = {
  type: DocumentTypeSummary;
  workflow: { id: string; name: string } | null;
  requirementSets: string[];
};

/** 422 from save: what still blocks it. */
export type SaveLearnedBlocked = { error: string; overlaps: OverlapFlag[]; personalDetails: PersonalDetailFlag[]; validation?: LearnDraft["validation"] };

/** Any other refusal from the learn routes (400, 403, 404, 409, 429, 502, 503). */
export type LearnErrorResponse = { error: string; issues?: string[]; retryAfterSeconds?: number };

/** True when every validation list is empty (the draft can be saved once the flags are dealt with). */
export function draftValid(v: LearnDraft["validation"]): boolean {
  return !v.type.length && !v.workflow.length && !v.graph.length && !v.requirementSets.length;
}

// ---------------------------------------------------------------------------
// Evaluation harness (scripts/learn/evaluate.ts; not shipped UI)

/** The three ways a document is generated from the example's sources. */
export const EVAL_CONDITIONS = ["extracted", "nearest", "none"] as const;
export type EvalCondition = (typeof EVAL_CONDITIONS)[number];

/**
 * One fixed test case (scripts/learn/eval-cases.json). Examples and sources are
 * fetched at run time and cached outside the repo; nothing whose licence is
 * unclear is committed.
 */
export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{2,60}$/),
  family: Family,
  title: z.string().trim().min(1).max(200),
  /** The example document (PDF or HTML). */
  exampleUrl: z.url(),
  /** Its own sources, when public (e.g. the papers an application cites); may be empty (then the example's notes are the source). */
  sourceUrls: z.array(z.url()).max(10).default([]),
  /** e.g. "Public domain (US government)", "CC BY 4.0", "unclear: fetched at run time, not committed". */
  license: z.string().trim().min(1).max(200),
  /** The catalog type a person would pick (the "nearest" condition), or null to let the classifier pick. */
  nearestType: z.string().max(80).nullable().default(null),
  notes: z.string().max(1000).optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

export type EvalScores = {
  /** Section match against the example's headings, 0..1 (F1 over matched sections, order-aware). */
  structure: number;
  /** Share of the example's key points the generated document covers, 0..1. */
  coverage: number;
  /** Mean rubric score 0..10 (type + universal rubric of the condition's type; universal only for "none"), or null when not run. */
  rubric: number | null;
  /** Findings from the condition's type workflow, by severity, and its outcome value. */
  findings: { blocking: number; warning: number; info: number };
  outcome: string | null;
};

export type EvalConditionResult = {
  condition: EvalCondition;
  typeKey: string | null;
  scores: EvalScores | null;
  error: string | null;
  durationMs: number;
  /** Total model tokens for this condition (input + output). */
  tokens: number;
};

export type EvalCaseResult = {
  caseId: string;
  title: string;
  family: string;
  keyPoints: string[];
  exampleHeadings: string[];
  extraction: { confidence: LearnConfidence; overlaps: number; personalDetails: number } | null;
  conditions: EvalConditionResult[];
  /** Best condition by structure + coverage + rubric/10 (equal weights), or null when all failed. */
  best: EvalCondition | null;
};

/** Written to the report path as JSON, with a Markdown rendering beside it. */
export type EvalReport = {
  version: 1;
  ranAt: string;
  models: Record<string, string>;
  cases: EvalCaseResult[];
  summary: {
    byCondition: Record<EvalCondition, { structure: number; coverage: number; rubric: number | null; cases: number }>;
    /** Cases where "extracted" scored above "nearest". */
    extractedBeatsNearest: number;
    total: number;
    /** PLAN §6.11: learn-from-example ships only if it beats the nearest catalog type. */
    verdict: "beats-nearest" | "does-not-beat-nearest" | "inconclusive";
  };
};
