// The editor's right column, as pure state (redesign3-spec.md §13): a stack of
// the Sources pill, then Agents, then Outline, where each of the last two is a
// button while closed and its card in the same place while open. The Agents
// place is the "lower" slot: Section notes and the rubric Check take it from
// Agents (from a heading's gutter, or the Agents card's own buttons), and their
// close puts the Agents button back. Which panels are open is remembered per
// document in localStorage, written only when the person opens or closes one.
// Kept apart from React so the rules are tested on their own.

export type LowerPanel = "agents" | "notes" | "check";

export type RightColumnState = { outline: boolean; lower: LowerPanel | null };

export const CLOSED_COLUMN: RightColumnState = { outline: false, lower: null };

/** The two places in the stack: Agents (or Section notes, or Check), and Outline. */
export type ColumnSlot = "outline" | "lower";

export type ColumnAction =
  | { type: "open"; slot: ColumnSlot }
  | { type: "close"; slot: ColumnSlot }
  /** Section notes replace Agents (or open alone); the outline stays as it is. */
  | { type: "notes" }
  /** The rubric Check results replace Agents or notes (or open alone). */
  | { type: "check" }
  /** Esc or the scrim in the drawer or sheet: everything closes. */
  | { type: "close_all" }
  /** The remembered panels, read once the document has loaded. */
  | { type: "restore"; panels: StoredPanels };

export function columnReducer(s: RightColumnState, action: ColumnAction): RightColumnState {
  switch (action.type) {
    case "open":
      return action.slot === "outline" ? { ...s, outline: true } : { ...s, lower: "agents" };
    case "close":
      return action.slot === "outline" ? { ...s, outline: false } : { ...s, lower: null };
    case "notes":
      return { ...s, lower: "notes" };
    case "check":
      return { ...s, lower: "check" };
    case "close_all":
      return CLOSED_COLUMN;
    case "restore":
      return { outline: action.panels.outline, lower: action.panels.agents ? "agents" : null };
  }
}

export const isColumnOpen = (s: RightColumnState): boolean => s.outline || s.lower !== null;

/**
 * Which stack button takes focus when a slot's card closes: the button that
 * now stands in its place. Section notes and Check have no button of their
 * own, so the lower slot always goes to Agents.
 */
export const columnCloseFocus = (slot: ColumnSlot): "outline" | "agents" => (slot === "outline" ? "outline" : "agents");

/** The cards' headings (tabIndex -1): opening a panel moves focus to its heading. */
export const AGENTS_HEADING_ID = "agents-heading";
export const OUTLINE_HEADING_ID = "outline-heading";
/** The slot wrappers, which the stack buttons point at with aria-controls while expanded. */
export const AGENTS_SLOT_ID = "editor-agents-slot";
export const OUTLINE_SLOT_ID = "editor-outline-slot";

/** Where focus goes when a panel opens: its card's heading. Section notes and Check focus their own controls. */
export const openFocusId = (slot: ColumnSlot): string => (slot === "outline" ? OUTLINE_HEADING_ID : AGENTS_HEADING_ID);

// --- Remembered per document ---------------------------------------------------------

/** What is stored: Section notes and Check aren't remembered (they need a section or a run). */
export type StoredPanels = { agents: boolean; outline: boolean };

export const panelsKey = (documentId: string) => `sasha.panels.${documentId}`;

/** The stored record for a column: Agents counts as open only while Agents itself shows. */
export const panelsOf = (s: RightColumnState): StoredPanels => ({ agents: s.lower === "agents", outline: s.outline });

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** The document's remembered panels, or null (never stored, unreadable, or storage blocked). */
export function readPanels(storage: StorageLike | null | undefined, documentId: string | null): StoredPanels | null {
  if (!documentId || !storage) return null;
  try {
    const raw = storage.getItem(panelsKey(documentId));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { agents, outline } = v as Record<string, unknown>;
    return { agents: agents === true, outline: outline === true };
  } catch {
    return null;
  }
}

/** Remembers the panels for a saved document. A new document (no id) isn't remembered: it always starts closed. */
export function writePanels(storage: StorageLike | null | undefined, documentId: string | null, panels: StoredPanels): void {
  if (!documentId || !storage) return;
  try {
    storage.setItem(panelsKey(documentId), JSON.stringify(panels));
  } catch {
    // A full or blocked storage (private windows, sandboxed previews): the panels just aren't remembered.
  }
}

/** window.localStorage, or null where touching it throws. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// --- Layout ----------------------------------------------------------------------------

/**
 * How the column is laid out: "inline" in the body row beside the text when
 * the editor card is wide enough for both (a 1280px window), "drawer" (the
 * stack stays at the top right; an open card overlays from the right) when it
 * isn't, and "sheet" on phones (a fixed row of buttons; cards in a bottom
 * sheet). Widths are CSS pixels; the breakpoints assume a 16px root.
 */
export type RightColumnMode = "inline" | "drawer" | "sheet";

/** The body row's width in a 1280px window (the card inside the frame's lg padding). */
export const INLINE_MIN_CONTAINER = 72 * 16;
export const SHEET_MAX_VIEWPORT = 640;

export function rightColumnMode(containerWidth: number, viewportWidth: number): RightColumnMode {
  if (viewportWidth < SHEET_MAX_VIEWPORT) return "sheet";
  return containerWidth >= INLINE_MIN_CONTAINER ? "inline" : "drawer";
}

/** Whether open cards cover the text (drawer or sheet): they are modal there, with a scrim and a focus trap. */
export const overlaysText = (mode: RightColumnMode, s: RightColumnState): boolean => mode !== "inline" && isColumnOpen(s);
