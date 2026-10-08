// The universal writing rubric (PLAN §5.2). Every type inherits these five
// criteria; a type's own `rubric` adds to them. Scale: 4 Strong, 3 Adequate,
// 2 Developing, 1 Weak. Stored now; scored in Phase 7 (`rubric.check`, §6.9).
//
// Provenance: paraphrased and hand-written from the Federal Plain Language
// Guidelines (digital.gov/guides/plain-language; public domain, CC0) and Google
// Technical Writing One and Two (developers.google.com/tech-writing; CC BY 4.0).
// No text is copied from either.

import type { DocumentTypeDefinition, RubricCriterion } from "./schema";

export const UNIVERSAL_RUBRIC_PROVENANCE = {
  source: "Federal Plain Language Guidelines; Google Technical Writing One and Two (paraphrased)",
  url: "https://digital.gov/guides/plain-language",
  license: "Own text (sources: public domain / CC0; CC BY 4.0)",
  retrieved: "2026-10-07",
} as const;

export const UNIVERSAL_RUBRIC: RubricCriterion[] = [
  {
    key: "clarity",
    criterion: "Clarity: each sentence has one clear meaning on first read.",
    levels: [
      { score: 4, descriptor: "Every sentence says one thing in active voice with a clear actor. Terms are defined on first use and used consistently. There are no ambiguous pronouns." },
      { score: 3, descriptor: "Mostly clear. A few long or passive sentences, or an undefined term, slow the reader without misleading them." },
      { score: 2, descriptor: "Frequent ambiguity: noun stacks, vague pronouns, inconsistent terms, or jargon left unexplained. The reader has to reread." },
      { score: 1, descriptor: "The meaning is often unclear or can be read more than one way. Key claims can't be pinned down." },
    ],
  },
  {
    key: "concision",
    criterion: "Concision: no more words than the meaning needs.",
    levels: [
      { score: 4, descriptor: "No filler, redundancy or throat-clearing. Sentences average about 20 words or fewer. Each paragraph earns its place." },
      { score: 3, descriptor: "Mostly tight. Some wordy phrases (\"in order to\", \"it is important to note\") or repetition." },
      { score: 2, descriptor: "Noticeable padding: repeated points, long introductions, verbs turned into nouns (\"make a determination\")." },
      { score: 1, descriptor: "Wordiness hides the content. The section could be cut by half without losing meaning." },
    ],
  },
  {
    key: "audience_fit",
    criterion: "Audience fit: written for the stated reader's knowledge, needs and task.",
    levels: [
      { score: 4, descriptor: "Assumes exactly the reader's background, answers their questions in order, and uses the tone and register the type specifies. Speaks to the reader directly where that fits." },
      { score: 3, descriptor: "Mostly well pitched. Occasionally over-explains or assumes too much." },
      { score: 2, descriptor: "Often written for the author or the wrong reader. Important context is missing, or there is condescending detail." },
      { score: 1, descriptor: "Ignores the intended audience. The reader can't use the document for its purpose." },
    ],
  },
  {
    key: "structure",
    criterion: "Structure: organised so the reader finds and follows the main points.",
    levels: [
      { score: 4, descriptor: "The most important information comes first. Headings are informative and match the type's outline. Paragraphs have topic sentences. Lists and tables are used where they help. Transitions are logical." },
      { score: 3, descriptor: "Sound overall. A few buried points, generic headings or long paragraphs." },
      { score: 2, descriptor: "The order is hard to follow. Key points are buried. Headings and lists are inconsistent or missing where needed." },
      { score: 1, descriptor: "No discernible organisation. Required sections are missing or out of order." },
    ],
  },
  {
    key: "evidence",
    criterion: "Evidence: claims are supported, accurate and attributed.",
    levels: [
      { score: 4, descriptor: "Every substantive claim is backed by cited sources or data. Figures are accurate and in context. Limits and uncertainty are stated. Nothing is invented." },
      { score: 3, descriptor: "Most claims are supported. A few general statements lack citation, or the support is thin." },
      { score: 2, descriptor: "Many claims are unsupported or loosely tied to sources. Some figures lack context." },
      { score: 1, descriptor: "Claims are asserted without support, or contradict the sources, or contain invented facts." },
    ],
  },
];

export const UNIVERSAL_RUBRIC_KEYS = new Set(UNIVERSAL_RUBRIC.map((c) => c.key));

/** The full rubric for a type: the universal criteria, then the type's own (a type criterion with a universal key replaces it). */
export function rubricFor(def: Pick<DocumentTypeDefinition, "rubric">): RubricCriterion[] {
  const own = new Map(def.rubric.map((c) => [c.key, c]));
  return [...UNIVERSAL_RUBRIC.map((c) => own.get(c.key) ?? c), ...def.rubric.filter((c) => !UNIVERSAL_RUBRIC_KEYS.has(c.key))];
}
