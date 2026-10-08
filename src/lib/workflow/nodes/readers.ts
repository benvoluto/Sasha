// The input nodes: the document (doc.read), its notes (doc.notes), its linked
// sources (sources.list) and their passages (sources.read), its data tables
// (data.list) and requirement sets (requirements.read). No model calls; each
// returns plain JSON plus a delimited text block for the ai.* nodes.

import { requirementItem, requirementRef, requirementSet, requirementSetsForType } from "@/catalog/workflows";
import { rubricFor } from "@/catalog";
import { sortedSections, type DocumentTypeDefinition } from "@/catalog/schema";
import type { RequirementSet } from "@/catalog/requirements-schema";
import { getTableRows, listDocumentTables } from "@/lib/data/store";
import { listSectionMeta } from "@/lib/documents/section-store";
import { docText, listSections, nodeText, wordCount } from "@/lib/documents/sections";
import type { DocumentRecord } from "@/lib/documents/store";
import { buildGrounding } from "@/lib/sections/grounding";
import { passagePrefix } from "@/lib/sources/pages";
import { listDocumentSources, type LinkedSource } from "@/lib/sources/store";
import { NodeError, type NodeContext, type NodeHandler } from "../context";
import { dataBlock, documentBlock, notesBlock, requirementsBlock, sourcesBlock } from "./prompts";
import { clip } from "./util";
import { MAX_DOC_TEXT, type DocSnapshot, type NotesView, type RequirementItemView, type RequirementsView, type SectionView, type SourceView, type SourcesSnapshot, type TableView, type TypeView } from "./types";

// --- doc.read ----------------------------------------------------------------------

/** The type as the steps see it: its sections (in order) and its full rubric. */
export function typeView(def: DocumentTypeDefinition): TypeView {
  return {
    key: def.key,
    title: def.title,
    version: def.version,
    family: def.family,
    sections: sortedSections(def.sections).map((s) => ({
      key: s.key,
      heading: s.heading,
      level: s.level,
      required: s.required,
      guidance: s.guidance,
      lengthHint: s.lengthHint,
      elements: s.elements,
      sourcesNeeded: s.sourcesNeeded,
      dataNeeded: s.dataNeeded,
      renderer: s.renderer,
    })),
    rubric: rubricFor(def),
  };
}

/** A heading's sectionId, or "s<index>" for one without (documents made in the editor always have one). */
export const sectionIdOf = (sectionId: string, index: number) => sectionId || `s${index}`;

/** Pure: the document snapshot (D) from the stored record and its type. */
export function snapshotDocument(doc: Pick<DocumentRecord, "id" | "title" | "type_key" | "updated_at" | "content_json" | "content_text">, def: DocumentTypeDefinition | null, sectionChars: number): DocSnapshot {
  const specs = new Map((def?.sections ?? []).map((s) => [s.key, s]));
  const sections: SectionView[] = listSections(doc.content_json, { own: true }).map((s) => {
    const spec = s.specKey ? specs.get(s.specKey) : undefined;
    return {
      sectionId: sectionIdOf(s.sectionId, s.index),
      heading: s.heading,
      level: s.level,
      specKey: s.specKey,
      index: s.index,
      text: clip(s.bodyText, sectionChars),
      wordCount: wordCount(s.proseText ?? s.bodyText),
      hasContent: !!s.hasContent,
      renderer: spec?.renderer ?? "narrative",
      required: spec?.required ?? false,
    };
  });
  const nodes = doc.content_json?.content ?? [];
  const firstHeading = nodes.findIndex((n) => n.type === "heading");
  const preamble = (firstHeading < 0 ? [] : nodes.slice(0, firstHeading)).map(nodeText).join("").trim();
  const text = (doc.content_text || docText(doc.content_json)).slice(0, MAX_DOC_TEXT);
  return {
    id: doc.id,
    title: doc.title,
    typeKey: doc.type_key,
    typeTitle: def?.title ?? null,
    updatedAt: doc.updated_at,
    wordCount: wordCount(text),
    text,
    preamble: clip(preamble, sectionChars),
    sections,
    type: def ? typeView(def) : null,
  };
}

export const docRead: NodeHandler = async (_inputs, node, ctx) => {
  const { sectionChars } = node.config as { sectionChars: number };
  const d = snapshotDocument(await ctx.document(), await ctx.type(), sectionChars);
  return {
    document: d,
    text: documentBlock(d),
    sections: d.sections,
    empty_sections: d.sections.filter((s) => !s.hasContent && s.renderer !== "static"),
    type: d.type,
  };
};

// --- doc.notes ---------------------------------------------------------------------

export const docNotes: NodeHandler = async (_inputs, _node, ctx) => {
  const doc = await ctx.document();
  const headings = new Map(listSections(doc.content_json).map((s) => [sectionIdOf(s.sectionId, s.index), s.heading]));
  const meta = (await listSectionMeta(ctx.teamId, ctx.documentId)) ?? [];
  const notes: NotesView = {
    scratchpad: doc.notes ?? "",
    sections: meta.filter((m) => m.notes.trim() && headings.has(m.section_id)).map((m) => ({ sectionId: m.section_id, heading: headings.get(m.section_id)!, notes: m.notes })),
  };
  return { notes, text: notesBlock(notes) };
};

// --- sources.list / sources.read ------------------------------------------------------

const READ = new Set(["ready", "partial"]);

export function sourceView(s: LinkedSource): SourceView {
  return { id: s.id, title: clip(s.title || s.filename || s.url || "Untitled source", 300), kind: s.kind, role: s.role, summary: (s.summary ?? "").trim(), status: s.extraction_status, url: s.url };
}

const linkedSources = (ctx: NodeContext) => ctx.memo("linked-sources", async () => (await listDocumentSources(ctx.teamId, ctx.documentId)) ?? []);

export const sourcesList: NodeHandler = async (_inputs, node, ctx) => {
  const { readyOnly } = node.config as { readyOnly: boolean };
  const sources = (await linkedSources(ctx)).filter((s) => !readyOnly || READ.has(s.extraction_status)).map(sourceView);
  return { sources, text: sourcesBlock({ sources, passages: [] }) };
};

/** Does a source's title, filename or role contain `needle` (case-insensitive)? */
export function sourceNameMatches(s: Pick<LinkedSource, "title" | "filename" | "role" | "url">, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return !n || [s.title, s.filename, s.role, s.url].some((v) => (v ?? "").toLowerCase().includes(n));
}

export const sourcesRead: NodeHandler = async (inputs, node, ctx) => {
  const { focus, budget, nameContains } = node.config as { focus: string; budget: number; nameContains: string };
  const def = await ctx.type();
  const grounding = await buildGrounding(ctx.teamId, ctx.documentId, {
    focus: [focus, typeof inputs.focus === "string" ? inputs.focus : "", ...(def?.sections ?? []).map((s) => s.heading)].filter(Boolean),
    budget,
  });
  const linked = new Map((await linkedSources(ctx)).map((s) => [s.id, s]));
  const keep = grounding.sources.filter((g) => {
    const s = linked.get(g.id);
    return s && sourceNameMatches(s, nameContains);
  });
  const sources = keep.map((g) => sourceView(linked.get(g.id)!));
  const byPrefix = new Map(sources.map((s) => [passagePrefix(s.id), s.id]));
  const passages = grounding.passages.flatMap((p) => {
    const sourceId = byPrefix.get(p.id.split(".")[0]);
    return sourceId ? [{ id: p.id, sourceId, page: p.page, text: p.text }] : [];
  });
  const snap: SourcesSnapshot = { sources, passages };
  // The grounding block when nothing was filtered out (it carries excerpts of sources with no passages).
  const text = keep.length === grounding.sources.length ? grounding.block : sourcesBlock(snap);
  return { sources: snap, passages, text };
};

// --- data.list -----------------------------------------------------------------------

export const dataList: NodeHandler = async (_inputs, node, ctx) => {
  const { maxRows } = node.config as { maxRows: number };
  const linked = ((await listDocumentTables(ctx.teamId, ctx.documentId)) ?? []).filter((t) => t.status === "active");
  const tables: TableView[] = [];
  for (const t of linked) {
    const rows = maxRows > 0 ? ((await getTableRows(ctx.teamId, t.id, 0, maxRows)) ?? []) : [];
    tables.push({
      id: t.id,
      name: t.name,
      sourceId: t.source_id,
      sourceTitle: t.source.title || t.source.filename || "Source",
      columns: t.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, unit: c.unit })),
      rowCount: t.row_count,
      rows: rows.map((r) => r.cells),
    });
  }
  return { tables, text: dataBlock(tables, maxRows) };
};

// --- requirements.read -----------------------------------------------------------------

/** Pure: the requirement sets and items a node reads. Empty `sets` and `items` mean the type's sets. Unknown keys fail. */
export function readRequirements(sets: string[], items: string[], typeKey: string | null): RequirementsView {
  const chosen: RequirementSet[] = [];
  const add = (s: RequirementSet) => {
    if (!chosen.some((c) => c.key === s.key)) chosen.push(s);
  };
  for (const key of sets) {
    const s = requirementSet(key);
    if (!s) throw new NodeError(`unknown requirement set “${key}”`);
    add(s);
  }
  if (!sets.length && !items.length) requirementSetsForType(typeKey).forEach(add);
  const view = (set: RequirementSet, i: RequirementSet["items"][number]): RequirementItemView => ({
    ref: `${set.key}#${i.key}`,
    title: i.title,
    kind: i.kind,
    text: i.text,
    value: i.value,
    unit: i.unit,
    appliesTo: i.appliesTo,
    citation: i.citation,
  });
  const out: RequirementItemView[] = chosen.flatMap((s) => s.items.map((i) => view(s, i)));
  const refSets = [...chosen];
  for (const ref of items) {
    const found = requirementItem(ref);
    if (!found) throw new NodeError(`unknown requirement “${ref}”`);
    if (!out.some((o) => o.ref === ref)) out.push(view(found.set, found.item));
    if (!refSets.some((s) => s.key === found.set.key)) refSets.push(found.set);
  }
  return { sets: refSets.map(requirementRef), items: out };
}

export const requirementsRead: NodeHandler = async (_inputs, node, ctx) => {
  const { sets, items } = node.config as { sets: string[]; items: string[] };
  const requirements = readRequirements(sets, items, (await ctx.document()).type_key);
  return { requirements, text: requirementsBlock(requirements) };
};

