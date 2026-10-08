// A new document's body built from a type's outline: one SectionHeading per
// section (carrying `specKey` and a fresh `sectionId`), then the section's
// scaffold or an empty paragraph. Pure and client-safe, used by
// POST /api/documents (new document of type) and the editor's type picker.
//
// CONTRACT (Phase 3): owned by the catalog-pipeline track.

import { nodeText, type PMNode } from "@/lib/documents/sections";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import { sortedSections, type SectionSummary } from "./schema";

type OutlineSection = Pick<SectionSummary, "key" | "heading" | "order"> & Partial<Pick<SectionSummary, "level" | "scaffold">>;

/** `s_` + 8 base-36 characters, the same shape the editor's newSectionId makes; works in the browser and in Node. */
export function randomSectionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `s_${Array.from(bytes, (b) => (b % 36).toString(36)).join("")}`;
}

export function headingNode(s: OutlineSection, sectionId: string): PMNode {
  return { type: "heading", attrs: { level: s.level ?? 2, sectionId, specKey: s.key }, content: [{ type: "text", text: s.heading }] };
}

/**
 * Blocks for one section: its heading, then the scaffold (headings kept below
 * the section level) or an empty paragraph. Scaffolds write one field per line,
 * so a single newline is kept as a line break rather than joined with a space.
 */
export function sectionNodes(s: OutlineSection, newId: () => string = randomSectionId): PMNode[] {
  const body = s.scaffold?.trim() ? sectionBlocksFromMarkdown(s.scaffold, s.level ?? 2, { lineBreaks: true }) : [{ type: "paragraph" }];
  return [headingNode(s, newId()), ...body];
}

export function outlineDoc(sections: OutlineSection[], newId: () => string = randomSectionId): PMNode {
  const content = sortedSections(sections).flatMap((s) => sectionNodes(s, newId));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

const squash = (s: string) => s.replace(/\s+/g, "");
const scaffoldKeys = new Map<string, string>();

/** The scaffold's text without its sub-heading titles or any whitespace: what an untouched scaffold body reads as. */
export function scaffoldKey(scaffold: string): string {
  let key = scaffoldKeys.get(scaffold);
  if (key === undefined) {
    const blocks = sectionBlocksFromMarkdown(scaffold, 2, { lineBreaks: true });
    key = squash(blocks.filter((b) => b.type !== "heading").map(nodeText).join(""));
    if (scaffoldKeys.size > 200) scaffoldKeys.clear();
    scaffoldKeys.set(scaffold, key);
  }
  return key;
}

/**
 * True when a section body's text (sub-heading titles left out) is still just
 * the section's scaffold as a new document seeds it (field labels with nothing
 * filled in), so the section counts as having no content yet. Whitespace and
 * formatting are ignored, so it reads the same from stored JSON and from the
 * live editor.
 */
export function isScaffoldOnly(text: string, scaffold: string | null | undefined): boolean {
  if (!scaffold?.trim()) return false;
  const key = scaffoldKey(scaffold);
  return key !== "" && squash(text) === key;
}
