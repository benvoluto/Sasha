// Test helpers for the section modules: a small valid document type and a
// document body with section headings. Used only by *.test.ts files.

import { parseDefinition, type DocumentTypeDefinition, type DocumentTypeInput } from "@/catalog/schema";
import type { PMNode } from "@/lib/documents/sections";

export const TEST_TYPE_INPUT: DocumentTypeInput = {
  key: "test-proposal",
  version: 3,
  title: "Test Proposal",
  family: "business",
  summary: "A short proposal used in tests.",
  signals: ["proposal"],
  audience: "Funding officers at a regional council.",
  tone: "Confident and concrete.",
  preamble: "You are a grant writer drafting a funding proposal.",
  aliases: ["test_proposal"],
  sections: [
    { key: "memo-header", heading: "Header", order: 5, renderer: "static", guidance: "Fixed header block.", scaffold: "**To:** \n**From:** " },
    { key: "summary", heading: "Summary", order: 10, guidance: "Summarize the request in one paragraph.", lengthHint: "150 words", elements: ["Amount requested", "Purpose"] },
    { key: "budget", heading: "Budget", order: 20, guidance: "Lay out the budget by line item.", elements: ["Line items", "Total"], sourcesNeeded: ["cost estimates"] },
    { key: "timeline", heading: "Timeline", order: 30, required: false, guidance: "Give the milestones.", elements: [] },
  ],
  provenance: { source: "hand-written", url: "", license: "Own text", retrieved: "2026-10-07" },
};

export function testType(overrides: Partial<DocumentTypeInput> = {}): DocumentTypeDefinition {
  const r = parseDefinition({ ...TEST_TYPE_INPUT, ...overrides });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.definition;
}

export const heading = (text: string, sectionId: string, specKey: string | null = null, level = 2): PMNode => ({
  type: "heading",
  attrs: { level, sectionId, specKey },
  content: [{ type: "text", text }],
});

export const para = (text: string): PMNode => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });

export const docOf = (...content: PMNode[]): PMNode => ({ type: "doc", content });
