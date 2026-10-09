// Pure logic behind the documents/folders panel (docs-panel.tsx): what the
// panel asks the API for, how it labels things, how Select mode's selection
// changes, and when Esc closes it. Kept free of React and the DOM so it can be
// tested directly (docs-panel-model.test.ts).

import { DOC_FOLDER_ROOT, type DocumentListItem } from "@/lib/documents/folders-contract";

/** Where the panel is: the top level (documents in no folder, plus the folder list) or inside one folder. */
export type PanelView = { kind: "root" } | { kind: "folder"; id: string; name: string };

export const ROOT_VIEW: PanelView = { kind: "root" };

/** The paths the app frame (rail + panel) shows on: the editor, a document, the library and the catalog. */
export function isWritingPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/") return true;
  if (pathname.startsWith("/d/")) return true;
  return ["/library", "/catalog"].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** The pages inside the app frame: the writing pages, the workflow canvas and the usage dashboard (both linked from the rail). */
export function inAppFrame(pathname: string | null | undefined): boolean {
  if (isWritingPath(pathname)) return true;
  return ["/workflows", "/usage"].some((p) => pathname === p || !!pathname?.startsWith(`${p}/`));
}

/** A row's date, as the mockup shows it: M/D/YYYY. Blank for a missing or unreadable timestamp. */
export function formatPanelDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

/** "1 document", "3 documents". */
export function documentCountLabel(n: number): string {
  return `${n} ${n === 1 ? "document" : "documents"}`;
}

/**
 * Searching or looking at the archive shows one flat list across every folder
 * (a match or an archived document is found wherever it is filed), and the
 * FOLDERS section steps aside.
 */
export function isFlatList(search: string, archived: boolean): boolean {
  return archived || search.trim() !== "";
}

/** The query string for GET /api/documents in this view (no leading "?"). */
export function listQuery(view: PanelView, search: string, archived: boolean): string {
  const params = new URLSearchParams();
  const q = search.trim();
  if (q) params.set("q", q);
  if (archived) params.set("archived", "1");
  if (!isFlatList(search, archived)) params.set("folder", view.kind === "folder" ? view.id : DOC_FOLDER_ROOT);
  return params.toString();
}

/** Whether a document (after a move) still belongs in the list the panel is showing. */
export function belongsInView(doc: Pick<DocumentListItem, "doc_folder_id">, view: PanelView, flat: boolean): boolean {
  if (flat) return true;
  return view.kind === "folder" ? doc.doc_folder_id === view.id : doc.doc_folder_id === null;
}

/** The title a row shows. */
export function displayTitle(title: string | null | undefined): string {
  return title?.trim() ? title : "Untitled document";
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
  /** Keep only ids still on screen (the list was refetched). */
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

/** True when every visible document is selected (the bulk bar's toggle then reads "Select none"). */
export function allSelected(selection: Selection, visibleIds: readonly string[]): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selection.includes(id));
}

// --- Esc -------------------------------------------------------------------------

/**
 * What Esc does while the panel is open. It is ignored when something else
 * already handled it (`defaultPrevented`) or when it was pressed inside a menu,
 * dialog, popover or inline edit (those close themselves); the first Esc in
 * Select mode only leaves Select mode.
 */
export function escapeAction(opts: { defaultPrevented: boolean; guarded: boolean; selecting: boolean }): "ignore" | "exit-select" | "close" {
  if (opts.defaultPrevented || opts.guarded) return "ignore";
  return opts.selecting ? "exit-select" : "close";
}

/** Elements whose own Esc handling wins over the panel's (see escapeAction). */
export const ESCAPE_GUARD_SELECTOR = '[role="menu"],[role="dialog"]:not(#docs-panel),[role="alertdialog"],[data-radix-popper-content-wrapper],[data-inline-edit]';

/** The message for a failed request, from its `{ error }` body or a fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// --- Focus -----------------------------------------------------------------------

/**
 * The row to focus once `removed` leave the list `ids` (archived, deleted or
 * moved out of view): the first remaining row after the first removed one,
 * else the last remaining row before it, else null (the list is empty, so the
 * panel heading takes focus).
 */
export function neighborAfterRemoval(ids: readonly string[], removed: readonly string[]): string | null {
  const gone = new Set(removed);
  const at = ids.findIndex((id) => gone.has(id));
  if (at === -1) return null;
  for (let i = at + 1; i < ids.length; i++) if (!gone.has(ids[i])) return ids[i];
  for (let i = at - 1; i >= 0; i--) if (!gone.has(ids[i])) return ids[i];
  return null;
}

/**
 * Tab and Shift+Tab inside the overlay panel's focus loop (the rail's
 * Documents button, then the panel's tabbable controls): the index to focus
 * next, wrapping at both ends. `index` is -1 when focus is on something
 * outside the list (the panel heading, or nothing), which sits just after the
 * rail button. Null when there is nothing to focus.
 */
export function trapNextIndex(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return shift ? 0 : Math.min(1, count - 1);
  return shift ? (index - 1 + count) % count : (index + 1) % count;
}
