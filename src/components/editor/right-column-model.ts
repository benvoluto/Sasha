// The editor's right column, as pure state: the outline on top and one lower
// panel (Tools or Section notes) below it. Outline and Tools are toggled by the
// floating buttons; opening notes from a heading's gutter takes the lower slot
// from Tools. Kept apart from React so the rules are tested on their own.

export type LowerPanel = "tools" | "notes";

export type RightColumnState = { outline: boolean; lower: LowerPanel | null };

export const CLOSED_COLUMN: RightColumnState = { outline: false, lower: null };

export const toggleOutline = (s: RightColumnState): RightColumnState => ({ ...s, outline: !s.outline });

/** Tools closes when it is showing; otherwise (nothing, or notes) Tools takes the lower slot. */
export const toggleTools = (s: RightColumnState): RightColumnState => ({ ...s, lower: s.lower === "tools" ? null : "tools" });

/** Section notes replace Tools (or open alone); the outline stays as it is. */
export const openNotes = (s: RightColumnState): RightColumnState => ({ ...s, lower: "notes" });

export const closeLower = (s: RightColumnState): RightColumnState => ({ ...s, lower: null });

export const closeOutline = (s: RightColumnState): RightColumnState => ({ ...s, outline: false });

/** The column's two slots: the outline on top, Tools or Section notes below. */
export type ColumnSlot = "outline" | "lower";

/**
 * Which floating button takes focus when a slot's panel is closed from its own
 * X: the button that reopens it. Section notes have no button of their own, so
 * the lower slot always goes to Tools.
 */
export const columnCloseFocus = (slot: ColumnSlot): "outline" | "tools" => (slot === "outline" ? "outline" : "tools");

export const isColumnOpen = (s: RightColumnState): boolean => s.outline || s.lower !== null;

/**
 * How the column is laid out: "inline" beside the text when the editor area is
 * at least 64rem wide, "drawer" (fixed on the right, over the text) when it is
 * narrower, and "sheet" (a bottom sheet above the floating buttons) on phones.
 * Widths are CSS pixels; 64rem and the sm breakpoint assume a 16px root.
 */
export type RightColumnMode = "inline" | "drawer" | "sheet";

export const INLINE_MIN_CONTAINER = 64 * 16;
export const SHEET_MAX_VIEWPORT = 640;

export function rightColumnMode(containerWidth: number, viewportWidth: number): RightColumnMode {
  if (viewportWidth < SHEET_MAX_VIEWPORT) return "sheet";
  return containerWidth >= INLINE_MIN_CONTAINER ? "inline" : "drawer";
}

/**
 * The column's classes in each mode. --toolbar-h and --column-top are measured
 * on the body row by the editing screen (--column-top is the row's top, never
 * above the sticky toolbar). The drawer starts there too, like the inline
 * column, so it never covers the header (Share) or the toolbar, which stay
 * visible and usable while it is open.
 */
export const RIGHT_COLUMN_MODE_CLASS: Record<RightColumnMode, string> = {
  inline:
    "sticky top-[var(--toolbar-h,0px)] h-[calc(100dvh-var(--column-top,var(--toolbar-h,0px)))] w-[22rem] shrink-0 self-start border-l border-[var(--doc-line)] pb-24",
  drawer:
    "fixed right-0 bottom-0 top-[var(--column-top,var(--toolbar-h,0px))] z-[18] w-[min(22rem,90vw)] border-l border-[var(--doc-line)] pb-24 shadow-xl",
  sheet:
    "fixed right-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-[18] max-h-[65dvh] rounded-t-2xl border-t border-[var(--doc-line)] shadow-2xl",
};
