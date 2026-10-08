// The living outline's model, kept pure so it can be tested: the type's
// sections merged with the headings in the editor now and the element statuses
// the server last computed (POST /api/documents/[id]/outline-status). Presence
// and "has content" come from the live document; element statuses come from the
// server and read "unknown" until it has seen the section's current content.

import type { Node as PMNode } from "@tiptap/pm/model";
import { isScaffoldOnly } from "@/catalog/outline";
import { sortedSections, type SectionSummary } from "@/catalog/schema";
import type { ElementStatus, OutlineStatusResponse } from "@/lib/sections/contract";

export type LiveHeading = {
  pos: number;
  level: number;
  text: string;
  /** The heading's sectionId (its position when it has none yet). */
  id: string;
  specKey: string | null;
  /**
   * The section's own body (up to the next heading at its level or higher, or
   * a sub-heading with a specKey, as sectionBodyRange reads it) has any text,
   * table or image. Sub-heading titles don't count.
   */
  hasContent: boolean;
  /** The own body's text without sub-heading titles (to tell an untouched scaffold from writing). */
  contentText?: string;
};

/** Top-level headings of the document, in order. */
export function readHeadings(doc: PMNode): LiveHeading[] {
  const blocks: Array<{ pos: number; node: PMNode }> = [];
  doc.forEach((node, pos) => blocks.push({ pos, node }));
  const out: LiveHeading[] = [];
  blocks.forEach(({ pos, node }, i) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level ?? 2);
    let hasContent = false;
    const text: string[] = [];
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j].node;
      if (b.type.name === "heading") {
        if (Number(b.attrs.level ?? 2) <= level || b.attrs.specKey) break;
        continue;
      }
      text.push(b.textContent);
      if (b.textContent.trim() || /^(table|image|horizontalRule)$/.test(b.type.name) || hasNonText(b)) hasContent = true;
    }
    out.push({
      pos,
      level,
      text: node.textContent,
      id: String(node.attrs.sectionId ?? pos),
      specKey: (node.attrs.specKey as string | null) || null,
      hasContent,
      contentText: text.join("\n"),
    });
  });
  return out;
}

function hasNonText(node: PMNode): boolean {
  let found = false;
  node.descendants((n) => {
    if (found) return false;
    if (n.type.name === "image" || n.type.name === "table") found = true;
    return !found;
  });
  return found;
}

export type RowStatus = "done" | "partial" | "missing";

export type OutlineRow = {
  key: string;
  /** The type's heading for the section. */
  heading: string;
  level: number;
  required: boolean;
  present: boolean;
  /** The heading in the document that carries this section's specKey. */
  sectionId: string | null;
  pos: number | null;
  /** The document's heading text, when it differs from the type's. */
  liveText: string | null;
  status: RowStatus;
  elements: Array<{ element: string; status: ElementStatus }>;
  hasNotes: boolean;
};

export type OutlineModel = {
  rows: OutlineRow[];
  /** Headings at the type's top level with no specKey, or one the type doesn't have. */
  other: LiveHeading[];
};

export function buildOutline({
  sections,
  headings,
  status,
  typeKey,
  notes,
}: {
  sections: SectionSummary[];
  headings: LiveHeading[];
  /** The server's last result; ignored when it was computed for another type. */
  status: OutlineStatusResponse | null;
  typeKey: string | null;
  /** Section notes by sectionId. */
  notes: Record<string, string>;
}): OutlineModel {
  const ordered = sortedSections(sections);
  const keys = new Set(ordered.map((s) => s.key));
  const byKey = new Map<string, LiveHeading>();
  for (const h of headings) if (h.specKey && keys.has(h.specKey) && !byKey.has(h.specKey)) byKey.set(h.specKey, h);
  const server = new Map<string, OutlineStatusResponse["sections"][number]>(status && status.typeKey === typeKey ? status.sections.map((s) => [s.specKey, s]) : []);

  const rows = ordered.map((s): OutlineRow => {
    const live = byKey.get(s.key) ?? null;
    // A body that is still the type's untouched scaffold (blank field labels) isn't content yet.
    const hasContent = !!live?.hasContent && !isScaffoldOnly(live.contentText ?? "", s.scaffold);
    let elements: OutlineRow["elements"];
    if (!hasContent) {
      elements = s.elements.map((element) => ({ element, status: "missing" as const }));
    } else {
      const seen = server.get(s.key);
      // The server's verdict only counts when it saw this section with content.
      const statuses = seen?.present && seen.hasContent ? new Map<string, ElementStatus>(seen.elements.map((e) => [e.element, e.status])) : null;
      elements = s.elements.map((element) => ({ element, status: statuses ? (statuses.get(element) ?? "missing") : ("unknown" as const) }));
    }
    const rowStatus: RowStatus = !hasContent ? "missing" : elements.every((e) => e.status === "done") ? "done" : "partial";
    return {
      key: s.key,
      heading: s.heading,
      level: s.level,
      required: s.required,
      present: !!live,
      sectionId: live && live.id !== String(live.pos) ? live.id : null,
      pos: live?.pos ?? null,
      liveText: live && live.text.trim() && live.text.trim() !== s.heading ? live.text : null,
      status: rowStatus,
      elements,
      hasNotes: !!(live && notes[live.id]?.trim()),
    };
  });

  const topLevel = ordered.length ? Math.min(...ordered.map((s) => s.level)) : 6;
  const other = headings.filter((h) => h.level <= topLevel && !(h.specKey && keys.has(h.specKey) && byKey.get(h.specKey) === h));
  return { rows, other };
}

/**
 * Where to insert a missing type section: after the nearest earlier type
 * section the document has (at the end of that section's range measured at the
 * new section's level, so a missing sub-section lands inside its parent and a
 * missing top-level section after the earlier one's sub-sections); else before
 * the nearest later one; else at the end.
 */
export function missingSectionInsertPos(sections: SectionSummary[], key: string, headings: LiveHeading[], docEnd: number): number {
  const ordered = sortedSections(sections);
  const index = ordered.findIndex((s) => s.key === key);
  if (index < 0) return docEnd;
  const level = ordered[index].level;
  const find = (k: string) => headings.find((h) => h.specKey === k) ?? null;
  for (let i = index - 1; i >= 0; i--) {
    const before = find(ordered[i].key);
    if (!before) continue;
    const next = headings.find((h) => h.pos > before.pos && h.level <= level);
    return next ? next.pos : docEnd;
  }
  for (let i = index + 1; i < ordered.length; i++) {
    const after = find(ordered[i].key);
    if (after) return after.pos;
  }
  return docEnd;
}
