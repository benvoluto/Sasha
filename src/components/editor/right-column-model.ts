// The editor's right column, as pure state: the outline card and one "lower"
// slot (Tools, Section notes or the rubric Check results), which since redesign
// 2 renders above the outline. The floating buttons only open Outline and
// Tools (each button hides while its card shows); opening notes from a
// heading's gutter takes the slot from Tools. Kept apart from React so the
// rules are tested on their own.

export type LowerPanel = "tools" | "notes" | "check";

export type RightColumnState = { outline: boolean; lower: LowerPanel | null };

export const CLOSED_COLUMN: RightColumnState = { outline: false, lower: null };

export const toggleOutline = (s: RightColumnState): RightColumnState => ({ ...s, outline: !s.outline });

/** Tools closes when it is showing; otherwise (nothing, or notes) Tools takes the lower slot. */
export const toggleTools = (s: RightColumnState): RightColumnState => ({ ...s, lower: s.lower === "tools" ? null : "tools" });

/** Section notes replace Tools (or open alone); the outline stays as it is. */
export const openNotes = (s: RightColumnState): RightColumnState => ({ ...s, lower: "notes" });

/** The rubric Check results replace Tools or notes (or open alone); the outline stays as it is. */
export const openCheck = (s: RightColumnState): RightColumnState => ({ ...s, lower: "check" });

/** Redesign 2: a floating button only opens its panel (the button hides while the panel shows; the panel's X closes it). */
export const openOutline = (s: RightColumnState): RightColumnState => ({ ...s, outline: true });
export const openTools = (s: RightColumnState): RightColumnState => ({ ...s, lower: "tools" });

export const closeLower = (s: RightColumnState): RightColumnState => ({ ...s, lower: null });

export const closeOutline = (s: RightColumnState): RightColumnState => ({ ...s, outline: false });

/** The column's two slots: Tools (or Section notes, or Check) on top, the outline below. */
export type ColumnSlot = "outline" | "lower";

/**
 * Which floating button takes focus when a slot's panel is closed from its own
 * X: the button that reopens it. Section notes and Check have no button of
 * their own, so the lower slot always goes to Tools.
 */
export const columnCloseFocus = (slot: ColumnSlot): "outline" | "tools" => (slot === "outline" ? "outline" : "tools");

/**
 * The slot wrappers (right-column.tsx), focusable (tabIndex -1) so focus can move
 * into a panel when its floating button hides (redesign2-spec.md §4.4).
 */
export const TOOLS_SLOT_ID = "editor-tools-slot";
export const OUTLINE_SLOT_ID = "editor-outline-slot";

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
 * The column's classes in each mode (redesign2-spec.md §4.5). The column has no
 * background or border of its own: it lays out floating cards, bottom-aligned
 * as in the mockup. --toolbar-h and --column-top are measured on the body row
 * by the editing screen (--column-top is the row's top, never above the sticky
 * toolbar). The drawer starts there too, like the inline column, so it never
 * covers the header or the toolbar. Inline and drawer keep their bottom clear
 * of the floating buttons (--fab-clearance, cleared when none shows); the
 * drawer only takes pointer events on the cards, so the text between and
 * around them stays clickable. The sheet is opaque instead: on a phone it spans
 * the width, and text showing (and taking clicks) in the gaps between its
 * stacked cards read as clutter.
 */
export const RIGHT_COLUMN_MODE_CLASS: Record<RightColumnMode, string> = {
  inline:
    "sticky top-[var(--toolbar-h,0px)] h-[calc(100dvh-var(--column-top,var(--toolbar-h,0px)))] w-[22rem] shrink-0 self-start flex flex-col justify-end gap-4 px-4 pt-4 pb-[max(1.25rem,var(--fab-clearance,0px))]",
  drawer:
    "fixed right-0 bottom-0 top-[var(--column-top,var(--toolbar-h,0px))] z-[18] w-[min(22rem,90vw)] flex flex-col justify-end gap-3 p-3 pb-[max(0.75rem,var(--fab-clearance,0px))] pointer-events-none bg-transparent shadow-none",
  sheet:
    "fixed right-0 bottom-[calc(var(--fab-clearance,0px)+env(safe-area-inset-bottom,0px))] z-[18] max-h-[70dvh] overflow-y-auto overscroll-contain flex flex-col gap-2 p-2 rounded-t-[24px] bg-[var(--editor-bg)] shadow-[0_-6px_20px_rgb(0_0_0/0.14)]",
};

/**
 * The classes of a slot (the wrapper around one card). Inline and drawer: one
 * card alone takes its natural height up to the column; with both open Tools
 * keeps its natural height up to 60% and the outline shrinks into the rest,
 * each scrolling inside. In the sheet the cards stack at their natural height
 * and the sheet scrolls. Drawer and sheet cards take the pointer events their
 * column gives up.
 */
export function slotClass(mode: RightColumnMode, slot: ColumnSlot, both: boolean): string {
  const base = "flex min-h-0 flex-col rounded-[20px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] [&>*]:min-h-0 [&>*]:flex-1";
  const floating = mode === "inline" ? "" : " [&>*]:pointer-events-auto";
  const lifted = mode === "drawer" ? " [&>*]:shadow-xl" : "";
  if (mode === "sheet") return `${base} flex-none${floating}`;
  const size = slot === "lower" && both ? " flex-none max-h-[60%]" : " flex-initial";
  return `${base}${size}${floating}${lifted}`;
}
