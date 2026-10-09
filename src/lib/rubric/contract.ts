// The on-demand rubric check (PLAN §6.9, decision 7): a section or the whole
// document scored against the type's rubric plus the universal one, on Sonnet,
// with quoted evidence checked against the document and a fix per criterion
// that the editor can apply as a section rewrite. Client-safe (zod, types and
// pure helpers): the check route parses requests with these schemas and the
// Check panel builds them.
//
// CONTRACT (Phase 7): see phase7-spec.md §3. Owned by the rubric track.

import { z } from "zod";
import { SectionId } from "@/lib/sections/contract";

export const CHECK_SCOPES = ["document", "section"] as const;
export type CheckScope = (typeof CHECK_SCOPES)[number];

/**
 * POST /api/documents/[id]/check. Runs against the STORED document: the
 * client saves first (ensureSaved). A section check scores only that section
 * (by sectionId) against the criteria that apply to it (no `appliesTo`, or
 * `appliesTo` naming its specKey).
 */
export const RubricCheckRequest = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("document"), force: z.boolean().optional() }),
  z.strictObject({ scope: z.literal("section"), sectionId: SectionId, force: z.boolean().optional() }),
]);
export type RubricCheckRequest = z.infer<typeof RubricCheckRequest>;

/** GET /api/documents/[id]/check?sectionId=… (omit for the document): the last result for that scope, or 404. */

/** A quote from the document the model relied on; only quotes found in the checked text are kept. */
export type CheckEvidence = {
  quote: string;
  sectionId: string | null;
  heading: string | null;
};

export type RubricCheckResult = {
  /** Criterion key ("clarity", "clear_ask"). */
  criterion: string;
  /** The criterion's text. */
  label: string;
  /** "universal" for a universal criterion the type does not override; "type" otherwise. */
  origin: "universal" | "type";
  level: number;
  maxLevel: number;
  /** Every level of the criterion, highest first, for the panel's level scale. */
  levels: Array<{ score: number; descriptor: string }>;
  rationale: string;
  evidence: CheckEvidence[];
  /** One concrete fix; empty at the top level. */
  fix: string;
  /** The section the fix should be applied to (Apply rewrites it); null when the fix is not about one section. */
  fixSectionId: string | null;
  fixSectionHeading: string | null;
};

export type RubricCheckResponse = {
  scope: CheckScope;
  sectionId: string | null;
  typeKey: string | null;
  typeVersion: number | null;
  /**
   * sha256 over the criteria checked, the type key and version, and the text
   * checked. Same hash = the cached result is returned (`cached: true`) unless
   * `force`.
   */
  inputsHash: string;
  cached: boolean;
  checkedAt: string;
  /** textFingerprint of each checked section's body as the server read it: Apply compares the editor's to it. */
  sectionFingerprints: Record<string, string>;
  results: RubricCheckResult[];
  /** Model evidence dropped because the quote was not in the document (count only). */
  droppedEvidence: number;
};

const CheckEvidenceShape = z.object({ quote: z.string(), sectionId: z.string().nullable(), heading: z.string().nullable() });

/** RubricCheckResponse at runtime: the Check panel parses responses with it, and the contract tests check replies against it. */
export const RubricCheckResponseShape = z.object({
  scope: z.enum(CHECK_SCOPES),
  sectionId: z.string().nullable(),
  typeKey: z.string().nullable(),
  typeVersion: z.number().nullable(),
  inputsHash: z.string().min(1),
  cached: z.boolean(),
  checkedAt: z.string(),
  sectionFingerprints: z.record(z.string(), z.string()),
  results: z.array(
    z.object({
      criterion: z.string(),
      label: z.string(),
      origin: z.enum(["universal", "type"]),
      level: z.number(),
      maxLevel: z.number(),
      levels: z.array(z.object({ score: z.number(), descriptor: z.string() })),
      rationale: z.string(),
      evidence: z.array(CheckEvidenceShape),
      fix: z.string(),
      fixSectionId: z.string().nullable(),
      fixSectionHeading: z.string().nullable(),
    }),
  ),
  droppedEvidence: z.number().int().min(0),
}) satisfies z.ZodType<RubricCheckResponse>;

/** Error bodies the route returns besides the usual { error }: 429 carries when to retry. */
export type RubricCheckError = { error: string; retryAfterSeconds?: number };

// --- Limits (the route's rate gate and cost caps) -------------------------------

/** Characters of document text a check sends; a longer document is checked by section instead. */
export const MAX_CHECK_CHARS = 120_000;
/** One check per scope per document per this long, unless the inputs changed. */
export const CHECK_MIN_INTERVAL_MS = 20_000;
/** Model checks per team per rolling hour. */
export const CHECK_TEAM_HOURLY_LIMIT = 40;
/** Criteria per check (type rubric max 20 + universal 5). */
export const MAX_CHECK_CRITERIA = 25;

// --- Pure helpers ---------------------------------------------------------------

/**
 * Whitespace-insensitive text for comparison: all whitespace removed. The
 * server's listSections and the editor's textBetween separate blocks, table
 * cells and hard breaks differently (a hard break is "\n" on the server and
 * nothing in textBetween), so only the non-space characters are compared.
 */
export const normalizeForFingerprint = (s: string) => s.replace(/\s+/g, "");

/**
 * A short, stable fingerprint of a section's text (FNV-1a 32-bit over the
 * normalized text, as 8 hex characters). Client and server compute it the
 * same way, so the panel can tell whether a section changed since the check.
 */
export function textFingerprint(s: string): string {
  const t = normalizeForFingerprint(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
