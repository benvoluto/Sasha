// Pure grouping and state for the Suggestions tab (suggestions-pane.tsx):
// open items by kind and then by the type section they serve, the Done and
// Dismissed groups, and the optimistic state change for an action.

import type { SuggestionActionRequest, SuggestionKind, SuggestionRecord } from "@/lib/suggestions/contract";

export const KIND_TITLES: Record<SuggestionKind, string> = {
  source: "Sources to find",
  data: "Data to gather",
  web: "On the web",
};
const KIND_ORDER: SuggestionKind[] = ["source", "data", "web"];

export const NOTES_GROUP = "From your notes";
export const OTHER_GROUP = "Other";

export type SectionGroup = { key: string; heading: string; items: SuggestionRecord[] };
export type KindGroup = { kind: SuggestionKind; title: string; count: number; sections: SectionGroup[] };

const byCreated = (a: SuggestionRecord, b: SuggestionRecord) => a.created_at.localeCompare(b.created_at) || a.label.localeCompare(b.label);

/**
 * Open suggestions grouped by kind (sources, data, web), and within a kind by
 * section in the type's order. Items with no (or an unknown) spec_ref go under
 * "From your notes" (notes origin) or "Other", after the sections.
 */
export function groupOpen(rows: SuggestionRecord[], sections: Array<{ key: string; heading: string }>): KindGroup[] {
  const order = new Map(sections.map((s, i) => [s.key, i]));
  const heading = new Map(sections.map((s) => [s.key, s.heading]));
  const out: KindGroup[] = [];
  for (const kind of KIND_ORDER) {
    const items = rows.filter((r) => r.state === "open" && r.kind === kind).sort(byCreated);
    if (!items.length) continue;
    const groups = new Map<string, SectionGroup>();
    for (const item of items) {
      const known = item.spec_ref !== null && heading.has(item.spec_ref);
      const key = known ? item.spec_ref! : item.origin === "notes" ? "~notes" : "~other";
      const title = known ? heading.get(item.spec_ref!)! : item.origin === "notes" ? NOTES_GROUP : OTHER_GROUP;
      const g = groups.get(key) ?? { key, heading: title, items: [] };
      g.items.push(item);
      groups.set(key, g);
    }
    const rank = (k: string) => (k === "~notes" ? sections.length : k === "~other" ? sections.length + 1 : (order.get(k) ?? sections.length + 2));
    out.push({ kind, title: KIND_TITLES[kind], count: items.length, sections: [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key)) });
  }
  return out;
}

/** Added suggestions, most recent first. */
export function doneItems(rows: SuggestionRecord[]): SuggestionRecord[] {
  return rows.filter((r) => r.state === "added").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Dismissed suggestions, most recent first. */
export function dismissedItems(rows: SuggestionRecord[]): SuggestionRecord[] {
  return rows.filter((r) => r.state === "dismissed").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** What a done row says: the source that covers it, or "Noted" (data items until Phase 5). */
export function doneText(row: Pick<SuggestionRecord, "kind" | "source_id">, sourceTitles: ReadonlyMap<string, string>): string {
  if (row.source_id) return `Covered by ${sourceTitles.get(row.source_id) ?? "a linked source"}`;
  return row.kind === "data" ? "Noted" : "Added";
}

/** The row as it will be after `action` (the optimistic update; the server's reply replaces it). */
export function applyAction(row: SuggestionRecord, action: SuggestionActionRequest["action"], sourceId?: string | null): SuggestionRecord {
  const updated_at = new Date().toISOString();
  if (action === "add") return { ...row, state: "added", source_id: row.kind === "data" ? null : (sourceId ?? row.source_id), updated_at };
  if (action === "dismiss") return { ...row, state: "dismissed", source_id: null, updated_at };
  return { ...row, state: "open", source_id: null, updated_at };
}

/** Replace one row by id (or append it when new). */
export function upsertRow(rows: SuggestionRecord[], row: SuggestionRecord): SuggestionRecord[] {
  return rows.some((r) => r.id === row.id) ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row];
}

/** Whether to show the "choose a type or write notes" empty state rather than an empty list. */
export function showEmptyHint(rows: SuggestionRecord[], typeKey: string | null): boolean {
  return rows.length === 0 && !typeKey;
}

/**
 * Opening the tab: save what the document still has queued (notes typed or a
 * type picked within the save debounce) before loading, so the server judges
 * staleness against the inputs on screen rather than the last saved ones. A
 * failed save doesn't block the load; the save queue retries it itself.
 */
export async function loadAfterSave<T>(ensureSaved: (() => Promise<unknown>) | undefined, load: () => Promise<T>): Promise<T> {
  if (ensureSaved) await ensureSaved().catch(() => null);
  return load();
}
