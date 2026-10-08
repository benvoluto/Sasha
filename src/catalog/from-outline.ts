// "Save outline as type": a team type built from a document's headings. Pure
// (no database), so the key derivation and section mapping are unit-tested;
// src/catalog/index.ts saveOutlineAsType loads the document and stores the
// result.

import type { SectionInfo } from "@/lib/documents/sections";
import { ITEM_KEY_RE, type DocumentTypeDefinition, type DocumentTypeInput, type Family } from "./schema";

export const GENERIC_PREAMBLE =
  "You are an experienced writer drafting a clear, well-organized document for a general professional audience. Write in plain, neutral prose with short paragraphs.";
export const GENERIC_AUDIENCE = "General professional readers.";
export const GENERIC_TONE = "Plain, neutral, professional.";

/** Lowercase words joined by "-", ASCII only; "" when nothing usable is left. */
export function slugify(text: string, maxLen = 60): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

/** `base`, else `base-2`, `base-3`, … — the first not in `taken`. */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base}-${n}`;
    if (!taken.has(k)) return k;
  }
}

/** The type key a title suggests: its slug, or "team-type" when the title has no usable characters. */
export function typeKeyFromTitle(title: string): string {
  const s = slugify(title, 70);
  return s.length >= 2 ? s : "team-type";
}

const isItemKey = (k: string | null | undefined): k is string => !!k && k.length <= 80 && ITEM_KEY_RE.test(k);

/** The headings that become the type's sections: those at the smallest level in use, with text. */
export function outlineHeadings(sections: SectionInfo[]): SectionInfo[] {
  const named = sections.filter((s) => s.heading.trim());
  if (!named.length) return [];
  const top = Math.min(...named.map((s) => s.level));
  return named.filter((s) => s.level === top);
}

export type OutlineTypeInput = {
  key: string;
  title: string;
  family?: Family;
  summary?: string;
  documentTitle: string;
  sections: SectionInfo[];
  /** The document's current type, if any: preamble/audience/tone/family and matching sections' elements come from it. */
  source: DocumentTypeDefinition | null;
  /** YYYY-MM-DD */
  today: string;
};

/** The definition (not yet validated) and the sectionId → section key map; null when the document has no headings. */
export function outlineTypeDefinition(input: OutlineTypeInput): { definition: DocumentTypeInput; specKeys: Record<string, string> } | null {
  const headings = outlineHeadings(input.sections);
  if (!headings.length) return null;
  const sourceSpecs = new Map((input.source?.sections ?? []).map((s) => [s.key, s]));
  const used = new Set<string>();
  const specKeys: Record<string, string> = {};
  const sections = headings.map((h, i) => {
    const heading = h.heading.trim().slice(0, 200);
    const key = isItemKey(h.specKey) && !used.has(h.specKey) ? h.specKey : uniqueKey(slugify(heading) || "section", used);
    used.add(key);
    if (h.sectionId) specKeys[h.sectionId] = key;
    const matched = h.specKey ? sourceSpecs.get(h.specKey) : undefined;
    return {
      key,
      heading,
      level: 2 as const,
      order: (i + 1) * 10,
      required: true,
      guidance: `Write the "${heading}" section of this document.`,
      elements: matched?.elements ?? [],
      sourcesNeeded: matched?.sourcesNeeded ?? [],
      dataNeeded: matched?.dataNeeded ?? [],
    };
  });
  const docTitle = input.documentTitle.trim() || "Untitled document";
  const summary =
    input.summary?.trim() ||
    `A team type saved from the outline of "${docTitle}". Sections: ${sections.map((s) => s.heading).join(", ")}.`.slice(0, 1000);
  const definition: DocumentTypeInput = {
    key: input.key,
    version: 1,
    title: input.title.trim(),
    family: input.family ?? input.source?.family ?? "general",
    summary,
    signals: [],
    audience: input.source?.audience ?? GENERIC_AUDIENCE,
    tone: input.source?.tone ?? GENERIC_TONE,
    preamble: input.source?.preamble ?? GENERIC_PREAMBLE,
    aliases: [],
    sections,
    rubric: [],
    provenance: { source: "Saved from a document outline", url: "", license: "Team", retrieved: input.today },
  };
  return { definition, specKeys };
}
