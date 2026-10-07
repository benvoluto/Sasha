// A document's own edits to its suggested sources and data: suggestions the
// team dismissed, and items the team added by hand. Pure and client-safe.

export type SuggestionKind = "sources" | "data";
export type SuggestionEdits = {
  dismissed: Record<SuggestionKind, string[]>;
  added: Record<SuggestionKind, string[]>;
};
export type SuggestionAction = "dismiss" | "restore" | "add" | "remove";

export const emptyEdits = (): SuggestionEdits => ({ dismissed: { sources: [], data: [] }, added: { sources: [], data: [] } });

/** Suggestions are matched by name, ignoring case and spacing, so "Report cards" and "report  cards" are one item. */
export const sameItem = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** Read edits off a stored record, tolerating a missing or partial record. */
export function editsOf(meta: unknown): SuggestionEdits {
  const raw = (meta as { suggestionEdits?: Partial<SuggestionEdits> } | null)?.suggestionEdits;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
  return {
    dismissed: { sources: list(raw?.dismissed?.sources), data: list(raw?.dismissed?.data) },
    added: { sources: list(raw?.added?.sources), data: list(raw?.added?.data) },
  };
}

export function applyAction(edits: SuggestionEdits, kind: SuggestionKind, action: SuggestionAction, name: string): SuggestionEdits {
  const next: SuggestionEdits = {
    dismissed: { ...edits.dismissed, [kind]: [...edits.dismissed[kind]] },
    added: { ...edits.added, [kind]: [...edits.added[kind]] },
  };
  const without = (xs: string[]) => xs.filter((x) => !sameItem(x, name));
  switch (action) {
    case "dismiss":
      next.dismissed[kind] = [...without(next.dismissed[kind]), name.trim()];
      break;
    case "restore":
      next.dismissed[kind] = without(next.dismissed[kind]);
      break;
    case "add":
      next.added[kind] = [...without(next.added[kind]), name.trim()];
      // Adding an item the team had dismissed brings it back.
      next.dismissed[kind] = without(next.dismissed[kind]);
      break;
    case "remove":
      next.added[kind] = without(next.added[kind]);
      break;
  }
  return next;
}

export const isDismissed = (edits: SuggestionEdits, kind: SuggestionKind, name: string) => edits.dismissed[kind].some((d) => sameItem(d, name));
