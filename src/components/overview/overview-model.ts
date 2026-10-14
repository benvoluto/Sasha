// Pure logic behind the documents overview (overview.tsx, redesign3-spec.md
// §2): the view the address names (tab, folder, archive), what the grid asks
// GET /api/documents for, how cards are labelled, how Select mode's selection
// changes and what Esc does, and the tablist's arrow keys. Ported from the old
// documents panel's model (docs-panel-model.ts). Kept free of React and the
// DOM so it can be tested directly (overview-model.test.ts).

import { DOC_FOLDER_ROOT, type DocumentListItem } from "@/lib/documents/folders-contract";

export type OverviewTab = "documents" | "notes";

/** Where the Documents tab is: the top level (documents in no folder, plus the folder tiles), one folder, or the archive. */
export type OverviewView = { kind: "root" } | { kind: "folder"; id: string } | { kind: "archived" };

export const ROOT_VIEW: OverviewView = { kind: "root" };

/** The drag payload's type when a card is dragged onto a folder tile (its value is the document id). */
export const DOC_DRAG_TYPE = "text/x-sasha-doc";

/** How many documents the grid asks for at once. */
export const OVERVIEW_LIST_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tab and view in the address: `?tab=notes`, `?folder=<uuid>`, `?view=archived`. Anything else is the root. */
export function parseOverviewParams(params: { get(name: string): string | null }): { tab: OverviewTab; view: OverviewView } {
  const tab: OverviewTab = params.get("tab") === "notes" ? "notes" : "documents";
  const folder = params.get("folder");
  const view: OverviewView = params.get("view") === "archived" ? { kind: "archived" } : folder && UUID.test(folder) ? { kind: "folder", id: folder.toLowerCase() } : ROOT_VIEW;
  return { tab, view };
}

/** The address for a tab and view ("/" for the root of the Documents tab). The Notes tab has no folder. */
export function overviewHref(tab: OverviewTab, view: OverviewView): string {
  const params = new URLSearchParams();
  if (tab === "notes") params.set("tab", "notes");
  else if (view.kind === "folder") params.set("folder", view.id);
  else if (view.kind === "archived") params.set("view", "archived");
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

/**
 * Searching shows one flat grid across every folder (a match is found wherever
 * it is filed) and the folder tiles step aside. The archive is always flat.
 */
export function isFlatList(view: OverviewView, search: string): boolean {
  return view.kind === "archived" || search.trim() !== "";
}

/** The query string for GET /api/documents in this view (no leading "?"). */
export function listQuery(view: OverviewView, search: string, limit = OVERVIEW_LIST_LIMIT): string {
  const params = new URLSearchParams();
  const q = search.trim();
  if (q) params.set("q", q);
  if (view.kind === "archived") params.set("archived", "1");
  if (!isFlatList(view, search)) params.set("folder", view.kind === "folder" ? view.id : DOC_FOLDER_ROOT);
  params.set("limit", String(limit));
  return params.toString();
}

/** Whether a document (after a move) still belongs in the grid being shown. */
export function belongsInView(doc: Pick<DocumentListItem, "doc_folder_id">, view: OverviewView, flat: boolean): boolean {
  if (flat) return true;
  return view.kind === "folder" ? doc.doc_folder_id === view.id : doc.doc_folder_id === null;
}

/** The title a card shows (and names its controls with). */
export function displayTitle(title: string | null | undefined): string {
  return title?.trim() ? title.trim() : "Untitled";
}

/** "1 document", "3 documents". */
export function documentCountLabel(n: number): string {
  return `${n} ${n === 1 ? "document" : "documents"}`;
}

/** The page's sr-only h1: "Documents", the folder's name, "Archived" or "Notes". */
export function overviewHeading(tab: OverviewTab, view: OverviewView, folderName: string | null): string {
  if (tab === "notes") return "Notes";
  if (view.kind === "archived") return "Archived";
  if (view.kind === "folder") return folderName || "Folder";
  return "Documents";
}

/** The tab an arrow, Home or End key moves to in the two-tab tablist, or null for any other key. */
export function tabForKey(current: OverviewTab, key: string): OverviewTab | null {
  const order: OverviewTab[] = ["documents", "notes"];
  const i = order.indexOf(current);
  if (key === "ArrowRight" || key === "ArrowDown") return order[(i + 1) % order.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return order[(i - 1 + order.length) % order.length];
  if (key === "Home") return order[0];
  if (key === "End") return order[order.length - 1];
  return null;
}

// --- Select mode -----------------------------------------------------------------

/** The selected document ids, in the order they were picked. */
export type Selection = readonly string[];

export type SelectionAction =
  | { type: "toggle"; id: string }
  /** Select exactly these (Select all). */
  | { type: "all"; ids: readonly string[] }
  | { type: "none" }
  /** Drop these ids (a bulk action finished with them). */
  | { type: "prune"; ids: readonly string[] }
  /** Keep only ids still on screen (the grid was refetched). */
  | { type: "retain"; ids: readonly string[] };

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case "toggle":
      return state.includes(action.id) ? state.filter((id) => id !== action.id) : [...state, action.id];
    case "all":
      return [...new Set(action.ids)];
    case "none":
      return state.length === 0 ? state : [];
    case "prune": {
      const drop = new Set(action.ids);
      const next = state.filter((id) => !drop.has(id));
      return next.length === state.length ? state : next;
    }
    case "retain": {
      const keep = new Set(action.ids);
      const next = state.filter((id) => keep.has(id));
      return next.length === state.length ? state : next;
    }
  }
}

/** True when every visible document is selected (the bar's toggle then reads "Select none"). */
export function allSelected(selection: Selection, visibleIds: readonly string[]): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selection.includes(id));
}

/** "Delete 1 document?", "Delete 3 documents?" (the Select bar's confirm). */
export function bulkDeleteQuestion(n: number): string {
  return `Delete ${documentCountLabel(n)}?`;
}

/** The notice after a bulk action skipped ids the server didn't find. Null when none were skipped. */
export function missingNotice(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 document wasn't found and was left alone. It may have been deleted." : `${n} documents weren't found and were left alone. They may have been deleted.`;
}

// --- Esc -------------------------------------------------------------------------

/**
 * What Esc does on the overview. It is ignored when something else already
 * handled it (`defaultPrevented`) or when it was pressed inside a menu,
 * dialog, popover or inline edit (those close themselves); otherwise it leaves
 * Select mode, if that is on.
 */
export function escapeAction(opts: { defaultPrevented: boolean; guarded: boolean; selecting: boolean }): "ignore" | "exit-select" {
  if (opts.defaultPrevented || opts.guarded || !opts.selecting) return "ignore";
  return "exit-select";
}

/** Elements whose own Esc handling wins over the overview's (see escapeAction). */
export const ESCAPE_GUARD_SELECTOR = '[role="menu"],[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper],[data-inline-edit]';

/** The message for a failed request, from its `{ error }` body or a fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// --- Focus -----------------------------------------------------------------------

/**
 * The card to focus once `removed` leave the grid `ids` (archived, deleted or
 * moved out of view): the first remaining card after the first removed one,
 * else the last remaining card before it, else null (the grid is empty).
 */
export function neighborAfterRemoval(ids: readonly string[], removed: readonly string[]): string | null {
  const gone = new Set(removed);
  const at = ids.findIndex((id) => gone.has(id));
  if (at === -1) return null;
  for (let i = at + 1; i < ids.length; i++) if (!gone.has(ids[i])) return ids[i];
  for (let i = at - 1; i >= 0; i--) if (!gone.has(ids[i])) return ids[i];
  return null;
}
