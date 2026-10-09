// Requirement sets: limits, criteria, checklists and deadlines that agencies
// change on their own schedules (state eligibility criteria, NIH page limits
// and review factors, reporting guidelines). Stored as dated data beside the
// types, apart from the workflow logic: one JSON file per set in
// src/catalog/requirements/, bundled by `npm run catalog:build` into
// requirements.bundle.json. Each set carries its source URL and the date it
// was checked, and is shown with "Verify before relying".
//
// Items are paraphrased (never copied text from a licensed checklist); a
// guideline whose items are licensed ships as a pointer (kind "guideline").
//
// Client-safe: zod and plain types only.
//
// CONTRACT (Phase 6): owned by the workflow-defs track.

import { z } from "zod";
import { TypeKey } from "./schema";

export const REQUIREMENT_SET_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const REQUIREMENT_ITEM_KEY_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const REQUIREMENT_KINDS = ["limit", "criterion", "checklist", "deadline", "policy", "guideline"] as const;
export const REQUIREMENT_UNITS = ["pages", "words", "characters", "school_days", "calendar_days", "business_days", "points", "years"] as const;

export const RequirementItem = z.strictObject({
  key: z.string().min(1).max(80).regex(REQUIREMENT_ITEM_KEY_RE),
  kind: z.enum(REQUIREMENT_KINDS),
  title: z.string().trim().min(1).max(200),
  /** The rule in plain words (paraphrased). */
  text: z.string().trim().min(1).max(3000),
  /** limit / deadline: the number and its unit. */
  value: z.number().optional(),
  unit: z.enum(REQUIREMENT_UNITS).optional(),
  /** Narrows the item: which sections, activity codes or categories it applies to. */
  appliesTo: z
    .strictObject({
      sections: z.array(z.string().max(80)).max(20).optional(),
      activityCodes: z.array(z.string().max(20)).max(20).optional(),
      categories: z.array(z.string().max(120)).max(20).optional(),
    })
    .optional(),
  /** The rule's own citation ("19 TAC §89.1040(c)(9)", "34 CFR 300.306(b)"). */
  citation: z.string().max(200).optional(),
  url: z.union([z.literal(""), z.url()]).optional(),
});
export type RequirementItem = z.output<typeof RequirementItem>;

export const RequirementSetShape = z.strictObject({
  key: z.string().min(2).max(80).regex(REQUIREMENT_SET_KEY_RE, "lowercase kebab-case"),
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  /** Who sets the rules: "Texas Education Agency", "NIH", "EQUATOR Network". */
  authority: z.string().trim().min(1).max(200),
  /** Where they apply: "Texas", "United States (federal)", "International". */
  jurisdiction: z.string().trim().min(1).max(120),
  /** Types the set applies to. */
  appliesTo: z.array(TypeKey).min(1).max(20),
  /**
   * The date the rules took effect ("" when the source the set paraphrases
   * gives none: never guessed), and the date Sasha last checked them against
   * the source.
   */
  effective: z.union([date, z.literal("")]),
  checked: date,
  /** The set this one replaces, if any. */
  supersedes: z.string().max(80).nullable().default(null),
  status: z.enum(["current", "superseded"]).default("current"),
  provenance: z.strictObject({
    source: z.string().trim().min(1).max(300),
    /** "" only for an inferred set (learned from an example, which has no rules page to link). */
    url: z.union([z.literal(""), z.url()]),
    license: z.string().trim().min(1).max(200),
  }),
  /**
   * Inferred from example documents (Phase 8, PLAN §6.11) rather than read from
   * the authority's rules: shown as "Inferred from examples, not from the
   * rules" and never offered as a cited rule. Catalog files are never inferred.
   */
  inferred: z.boolean().default(false),
  /** Shown with every use: agencies change these; check the source before relying on them. */
  verifyNote: z.string().trim().min(1).max(500).default("Verify before relying: agency rules change. Check the source for the current version."),
  items: z.array(RequirementItem).min(1).max(80),
});

export const RequirementSet = RequirementSetShape.superRefine((s, ctx) => {
  if (!s.inferred && !s.provenance.url) ctx.addIssue({ code: "custom", path: ["provenance", "url"], message: "a requirement set read from rules needs its source URL" });
  const seen = new Set<string>();
  s.items.forEach((it, i) => {
    if (seen.has(it.key)) ctx.addIssue({ code: "custom", path: ["items", i, "key"], message: `duplicate item key "${it.key}"` });
    seen.add(it.key);
    if ((it.kind === "limit" || it.kind === "deadline") && (it.value === undefined || !it.unit)) {
      ctx.addIssue({ code: "custom", path: ["items", i], message: `a ${it.kind} needs a value and a unit` });
    }
  });
});
export type RequirementSet = z.output<typeof RequirementSet>;
export type RequirementSetInput = z.input<typeof RequirementSet>;

export function parseRequirementSet(input: unknown): { ok: true; set: RequirementSet } | { ok: false; errors: string[] } {
  const r = RequirementSet.safeParse(input);
  if (r.success) return { ok: true, set: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** "<set>#<item>" → its parts, or null. */
export function parseRequirementRef(ref: string): { set: string; item: string } | null {
  const m = /^([a-z0-9-]+)#([a-z0-9_-]+)$/.exec(ref);
  return m ? { set: m[1], item: m[2] } : null;
}
