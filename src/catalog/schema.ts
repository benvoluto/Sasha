// The document-type definition (PLAN §4.4). One JSON file per type in
// src/catalog/types/, validated by this schema at build time
// (scripts/catalog/build.ts) and again when the bundle is loaded. Team-made and
// edited types (the document_type table) are validated by the same schema
// before they are stored.
//
// Client-safe: zod and plain types only. No server imports here.

import { z } from "zod";

/** Type keys: lowercase kebab-case, e.g. "nih-specific-aims-research-strategy". */
export const TYPE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Section and rubric keys: lowercase words joined by "-" or "_" (FIE keeps its snake_case keys). */
export const ITEM_KEY_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const TypeKey = z.string().min(2).max(80).regex(TYPE_KEY_RE, "lowercase kebab-case");
export const ItemKey = z.string().min(1).max(80).regex(ITEM_KEY_RE, "lowercase words joined by - or _");

export const FAMILIES = ["grant", "business", "academic", "technical", "policy", "clinical", "career", "legal", "general", "other"] as const;
export const Family = z.enum(FAMILIES);
export type Family = z.infer<typeof Family>;

/** How a section is produced. "pack:<name>" names a specialised renderer (e.g. pack:fie-exclusion); unknown packs fall back to narrative. */
export const Renderer = z.union([z.literal("narrative"), z.literal("static"), z.string().regex(/^pack:[a-z0-9-]+$/, "pack:<name>")]);
export type Renderer = z.infer<typeof Renderer>;

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (maxItems: number, maxLen = 300) => z.array(text(maxLen)).max(maxItems).default([]);

export const SectionSpec = z.strictObject({
  key: ItemKey,
  heading: text(200),
  /** Heading level in the editor. Top-level sections are 2; 1 is allowed for types that want a title-level heading. */
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  /** Sort order; sections are shown and generated in ascending order. */
  order: z.number().int().min(0).max(100_000),
  required: z.boolean().default(true),
  /** Drafting guidance for the model. For a static section, what the section is for. */
  guidance: text(4000),
  lengthHint: text(120).optional(),
  /** Required elements the living outline tracks (missing / partial / done). */
  elements: list(20),
  sourcesNeeded: list(20),
  dataNeeded: list(20),
  renderer: Renderer.default("narrative"),
  /** Markdown placed in the section body when the outline is created (e.g. a memo's To/From/Date block). */
  scaffold: z.string().max(4000).optional(),
});
export type SectionSpec = z.output<typeof SectionSpec>;

export const RubricLevel = z.strictObject({
  score: z.number().int().min(0).max(10),
  descriptor: text(1000),
});

export const RubricCriterion = z.strictObject({
  key: ItemKey,
  criterion: text(500),
  levels: z.array(RubricLevel).min(2).max(10),
  /** Section keys this criterion applies to; omitted means every section. */
  appliesTo: z.array(ItemKey).min(1).optional(),
});
export type RubricCriterion = z.output<typeof RubricCriterion>;

export const Provenance = z.strictObject({
  /** Where the structure came from, e.g. "NIH G.400 PHS 398 Research Plan", "hand-written", "user". */
  source: text(300),
  /** Link to the source; "" when there is none (hand-written or team types). */
  url: z.union([z.literal(""), z.url()]),
  /** e.g. "Public domain (US government)", "CC BY-SA 4.0 (paraphrased, attributed)", "Own text", "Team". */
  license: text(200),
  /** ISO date the source was read: YYYY-MM-DD. */
  retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
});
export type Provenance = z.output<typeof Provenance>;

const DocumentTypeShape = z.strictObject({
  key: TypeKey,
  version: z.number().int().min(1),
  title: text(120),
  family: Family,
  /** 2–3 sentences; the classifier reads this. */
  summary: text(1000),
  /** Phrases and cues the classifier looks for. */
  signals: list(40, 200),
  audience: text(500),
  tone: text(500),
  /** Who the model writes as and the rules every section follows (replaces the hardcoded report preambles). */
  preamble: text(4000),
  /** Earlier keys this type answers to (e.g. "fie_basic" for "fie"), so stored type_key values keep resolving. */
  aliases: z.array(z.string().min(1).max(80)).max(10).default([]),
  sections: z.array(SectionSpec).min(1).max(60),
  /** Type-specific criteria. The universal writing rubric (universal-rubric.ts) is always added on top; do not repeat it here. */
  rubric: z.array(RubricCriterion).max(20).default([]),
  provenance: Provenance,
});

function dupes(keys: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const k of keys) (seen.has(k) ? out : seen).add(k);
  return [...out];
}

export const DocumentTypeDefinition = DocumentTypeShape.superRefine((t, ctx) => {
  for (const k of dupes(t.sections.map((s) => s.key))) ctx.addIssue({ code: "custom", path: ["sections"], message: `duplicate section key "${k}"` });
  for (const k of dupes(t.rubric.map((r) => r.key))) ctx.addIssue({ code: "custom", path: ["rubric"], message: `duplicate rubric key "${k}"` });
  const sectionKeys = new Set(t.sections.map((s) => s.key));
  t.rubric.forEach((r, i) => {
    for (const k of r.appliesTo ?? []) {
      if (!sectionKeys.has(k)) ctx.addIssue({ code: "custom", path: ["rubric", i, "appliesTo"], message: `unknown section key "${k}"` });
    }
    for (const s of dupes(r.levels.map((l) => String(l.score)))) ctx.addIssue({ code: "custom", path: ["rubric", i, "levels"], message: `duplicate score ${s}` });
  });
  if (t.aliases.includes(t.key)) ctx.addIssue({ code: "custom", path: ["aliases"], message: "a type cannot alias its own key" });
});

/** A validated definition, with defaults applied. */
export type DocumentTypeDefinition = z.output<typeof DocumentTypeDefinition>;
/** What a JSON file may contain (defaults not yet applied). */
export type DocumentTypeInput = z.input<typeof DocumentTypeDefinition>;

/** One entry of the generated src/catalog/catalog.index.json (PLAN §5.3). */
export type CatalogIndexEntry = Pick<DocumentTypeDefinition, "key" | "version" | "title" | "family" | "summary" | "signals">;

/** Where an effective type comes from: a catalog file (possibly overridden by the team) or a team-made type. */
export type TypeOrigin = "file" | "team";

/** A type as one team sees it: the effective definition plus its catalog state. Server-side (src/catalog/index.ts). */
export type CatalogEntry = {
  definition: DocumentTypeDefinition;
  origin: TypeOrigin;
  enabled: boolean;
  /** A file type the team has edited (a document_type row with the same key). */
  overridden: boolean;
  updated_at: string | null;
};

/** Section fields the editor needs (type picker, outline creation, the living outline, the gutter). */
export type SectionSummary = Pick<SectionSpec, "key" | "heading" | "level" | "order" | "required" | "elements" | "renderer" | "lengthHint" | "scaffold">;

/** The client-safe projection returned by GET /api/document-types. Sections are sorted by `order`. */
export type DocumentTypeSummary = Pick<DocumentTypeDefinition, "key" | "version" | "title" | "family" | "summary" | "aliases"> & {
  origin: TypeOrigin;
  enabled: boolean;
  overridden: boolean;
  sections: SectionSummary[];
};

export function sortedSections<T extends { order: number }>(sections: T[]): T[] {
  return [...sections].sort((a, b) => a.order - b.order);
}

export function toTypeSummary(e: CatalogEntry): DocumentTypeSummary {
  const d = e.definition;
  return {
    key: d.key,
    version: d.version,
    title: d.title,
    family: d.family,
    summary: d.summary,
    aliases: d.aliases,
    origin: e.origin,
    enabled: e.enabled,
    overridden: e.overridden,
    sections: sortedSections(d.sections).map((s) => ({
      key: s.key,
      heading: s.heading,
      level: s.level,
      order: s.order,
      required: s.required,
      elements: s.elements,
      renderer: s.renderer,
      lengthHint: s.lengthHint,
      scaffold: s.scaffold,
    })),
  };
}

/** Parse untrusted input (a JSON file, an admin edit) into a definition, or a readable list of problems. */
export function parseDefinition(input: unknown): { ok: true; definition: DocumentTypeDefinition } | { ok: false; errors: string[] } {
  const r = DocumentTypeDefinition.safeParse(input);
  if (r.success) return { ok: true, definition: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
