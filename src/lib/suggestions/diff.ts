// Pure set logic for suggestions (phase4-spec.md §4.2): the items a document
// type needs, subtracting what the person dismissed and what linked sources
// already cover, merging the notes-driven proposals in, and the hash of the
// inputs that decides whether a regeneration is due.
//
// Nothing here touches the store or the model; generate.ts wires it together.

import { createHash } from "node:crypto";
import { sortedSections, type DocumentTypeDefinition } from "@/catalog/schema";
import { MAX_SUGGESTION_LABEL, MAX_SUGGESTION_REASON, suggestionDedupeKey, type SuggestionKind, type SuggestionRecord } from "./contract";

/** At most this many type-driven items per document (the big types list ~50). */
export const MAX_TYPE_ITEMS = 40;
/** At most this many notes-driven proposals per generation. */
export const MAX_NOTES_PROPOSALS = 8;

/** One thing the document should gather, before it is stored. */
export type NeededItem = {
  kind: SuggestionKind;
  label: string;
  reason: string;
  /** The type section it serves (the first one, for items several sections use). */
  spec_ref: string | null;
  dedupe_key: string;
};

/**
 * What a generation writes for one origin: the item plus, when a linked source
 * covers it, that source (stored as state "added" with the source id), or for
 * a data item, the linked data table that covers it (stored with data_table_id).
 */
export type GeneratedItem = Omit<NeededItem, "dedupe_key"> & { url?: string | null; covered_by?: string | null; covered_by_table?: string | null };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** A needed item with its dedupe key, label and reason trimmed to the stored limits. */
export function neededItem(kind: SuggestionKind, label: string, reason: string, spec_ref: string | null): NeededItem {
  const l = clip(label.trim().replace(/\s+/g, " "), MAX_SUGGESTION_LABEL);
  return { kind, label: l, reason: clip(reason.trim(), MAX_SUGGESTION_REASON), spec_ref, dedupe_key: suggestionDedupeKey(kind, l) };
}

/**
 * The type's sourcesNeeded (kind "source") and dataNeeded (kind "data"), in
 * section order, deduped by suggestionDedupeKey. An item several sections need
 * keeps the first section as its spec_ref; the others are named in its reason.
 * Capped at MAX_TYPE_ITEMS.
 */
export function typeNeeds(def: Pick<DocumentTypeDefinition, "sections">): NeededItem[] {
  const found = new Map<string, { kind: SuggestionKind; label: string; first: string; firstHeading: string; also: string[] }>();
  for (const section of sortedSections(def.sections)) {
    const add = (kind: SuggestionKind, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      const key = suggestionDedupeKey(kind, trimmed);
      const prev = found.get(key);
      if (!prev) found.set(key, { kind, label: trimmed, first: section.key, firstHeading: section.heading, also: [] });
      else if (prev.first !== section.key && !prev.also.includes(section.heading)) prev.also.push(section.heading);
    };
    for (const s of section.sourcesNeeded ?? []) add("source", s);
    for (const d of section.dataNeeded ?? []) add("data", d);
  }
  return [...found.values()].slice(0, MAX_TYPE_ITEMS).map((f) => {
    const reason = `The ${f.firstHeading} section uses this.${f.also.length ? ` Also used in: ${f.also.join(", ")}.` : ""}`;
    return neededItem(f.kind, f.label, reason, f.first);
  });
}

/** Items the person has not dismissed (a dismissed row with the same dedupe key hides the item). */
export function subtractDismissed<T extends { kind: SuggestionKind; label: string }>(items: T[], rows: Array<Pick<SuggestionRecord, "kind" | "label" | "state">>): T[] {
  const dismissed = new Set(rows.filter((r) => r.state === "dismissed").map((r) => suggestionDedupeKey(r.kind, r.label)));
  return items.filter((i) => !dismissed.has(suggestionDedupeKey(i.kind, i.label)));
}

/** Items no linked source covers. `coverage` maps an item's dedupe key to the covering source id. */
export function subtractCovered<T extends { kind: SuggestionKind; label: string }>(items: T[], coverage: ReadonlyMap<string, string>): T[] {
  return items.filter((i) => !coverage.has(suggestionDedupeKey(i.kind, i.label)));
}

/**
 * The notes-driven proposals worth writing: deduped among themselves and
 * against the type items (a duplicate of a type item is dropped; the type item
 * wins and keeps its spec_ref). Capped at MAX_NOTES_PROPOSALS.
 */
export function mergeProposals<T extends { kind: SuggestionKind; label: string }>(typeItems: Array<{ kind: SuggestionKind; label: string }>, notesItems: T[]): T[] {
  const seen = new Set(typeItems.map((i) => suggestionDedupeKey(i.kind, i.label)));
  const out: T[] = [];
  for (const item of notesItems) {
    const key = suggestionDedupeKey(item.kind, item.label);
    if (!item.label.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_NOTES_PROPOSALS) break;
  }
  return out;
}

export type SuggestionInputs = {
  typeKey: string | null;
  typeVersion: number | null;
  notes: string;
  sources: Array<{ id: string; title: string | null; summary: string | null }>;
  /** The document's linked data tables (Phase 5). */
  tables?: Array<{ id: string; name: string; status: string; columns: Array<{ label: string; type: string }> }>;
};

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * sha256 of the generation inputs as stable JSON (sources and tables sorted by
 * id, so link order doesn't matter). With no linked tables the hash is the
 * same as before tables existed, so documents without data don't all go stale.
 */
export function inputsHash(i: SuggestionInputs): string {
  const sources = [...i.sources].sort(byId).map((s) => [s.id, s.title ?? "", s.summary ?? ""]);
  const tables = [...(i.tables ?? [])].sort(byId).map((t) => [t.id, t.name, t.status, t.columns.map((c) => [c.label, c.type])]);
  const parts: unknown[] = [i.typeKey ?? null, i.typeVersion ?? null, i.notes.trim(), sources];
  if (tables.length) parts.push(tables);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
