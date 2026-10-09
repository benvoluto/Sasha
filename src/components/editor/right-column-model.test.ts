import { describe, expect, it } from "vitest";
import {
  CLOSED_COLUMN,
  closeLower,
  closeOutline,
  columnCloseFocus,
  isColumnOpen,
  openCheck,
  openNotes,
  openOutline,
  openTools,
  OUTLINE_SLOT_ID,
  RIGHT_COLUMN_MODE_CLASS,
  rightColumnMode,
  slotClass,
  TOOLS_SLOT_ID,
  toggleOutline,
  toggleTools,
  type RightColumnState,
} from "./right-column-model";

describe("right column state", () => {
  it("starts closed", () => {
    expect(isColumnOpen(CLOSED_COLUMN)).toBe(false);
  });

  it("toggles the outline without touching the lower panel", () => {
    const s = toggleOutline({ outline: false, lower: "tools" });
    expect(s).toEqual({ outline: true, lower: "tools" });
    expect(toggleOutline(s)).toEqual({ outline: false, lower: "tools" });
  });

  it("toggles tools open and closed", () => {
    const open = toggleTools(CLOSED_COLUMN);
    expect(open).toEqual({ outline: false, lower: "tools" });
    expect(toggleTools(open)).toEqual(CLOSED_COLUMN);
  });

  it("lets outline and tools be open together", () => {
    const s = toggleTools(toggleOutline(CLOSED_COLUMN));
    expect(s).toEqual({ outline: true, lower: "tools" });
    expect(isColumnOpen(s)).toBe(true);
  });

  it("notes replace tools, and tools after notes brings tools back", () => {
    const withTools: RightColumnState = { outline: true, lower: "tools" };
    const withNotes = openNotes(withTools);
    expect(withNotes).toEqual({ outline: true, lower: "notes" });
    expect(toggleTools(withNotes)).toEqual({ outline: true, lower: "tools" });
  });

  it("opening notes again keeps notes open", () => {
    expect(openNotes(openNotes(CLOSED_COLUMN))).toEqual({ outline: false, lower: "notes" });
  });

  it("check takes the lower slot beside the outline; tools from check brings tools back; its close X returns to Tools", () => {
    const s = openCheck({ outline: true, lower: "tools" });
    expect(s).toEqual({ outline: true, lower: "check" });
    expect(openCheck(s)).toEqual(s);
    expect(openCheck(openNotes(CLOSED_COLUMN))).toEqual({ outline: false, lower: "check" });
    expect(toggleTools(s)).toEqual({ outline: true, lower: "tools" });
    expect(closeLower(s)).toEqual({ outline: true, lower: null });
    expect(columnCloseFocus("lower")).toBe("tools");
  });

  it("closes each half on its own", () => {
    const s: RightColumnState = { outline: true, lower: "notes" };
    expect(closeLower(s)).toEqual({ outline: true, lower: null });
    expect(closeOutline(s)).toEqual({ outline: false, lower: "notes" });
    expect(isColumnOpen(closeOutline(closeLower(s)))).toBe(false);
  });

  it("opens the outline from its floating button, and opening again keeps it open", () => {
    expect(openOutline(CLOSED_COLUMN)).toEqual({ outline: true, lower: null });
    expect(openOutline({ outline: true, lower: "notes" })).toEqual({ outline: true, lower: "notes" });
  });

  it("opens Tools from its floating button, taking the slot back from notes or Check, and never closes it", () => {
    expect(openTools(CLOSED_COLUMN)).toEqual({ outline: false, lower: "tools" });
    expect(openTools({ outline: true, lower: "tools" })).toEqual({ outline: true, lower: "tools" });
    expect(openTools({ outline: true, lower: "notes" })).toEqual({ outline: true, lower: "tools" });
    expect(openTools({ outline: false, lower: "check" })).toEqual({ outline: false, lower: "tools" });
  });

  it("does not mutate its input", () => {
    const s: RightColumnState = { outline: false, lower: null };
    toggleOutline(s);
    toggleTools(s);
    openNotes(s);
    openOutline(s);
    openTools(s);
    expect(s).toEqual({ outline: false, lower: null });
  });
});

describe("rightColumnMode", () => {
  it("is a bottom sheet on phones whatever the container", () => {
    expect(rightColumnMode(2000, 639)).toBe("sheet");
    expect(rightColumnMode(300, 375)).toBe("sheet");
  });

  it("sits inline when the editor area is at least 64rem", () => {
    expect(rightColumnMode(1024, 1440)).toBe("inline");
    expect(rightColumnMode(1300, 1300)).toBe("inline");
  });

  it("is a drawer below 64rem on wider viewports", () => {
    expect(rightColumnMode(1023, 1440)).toBe("drawer");
    expect(rightColumnMode(700, 768)).toBe("drawer");
    expect(rightColumnMode(500, 640)).toBe("drawer");
  });
});

describe("right column placement", () => {
  it("starts the drawer below the header and toolbar, like the inline column", () => {
    const drawer = RIGHT_COLUMN_MODE_CLASS.drawer.split(/\s+/);
    expect(drawer).toContain("top-[var(--column-top,var(--toolbar-h,0px))]");
    // Pinned to the viewport top it would cover Share and the end of the toolbar.
    expect(drawer).not.toContain("inset-y-0");
    expect(drawer).not.toContain("top-0");
  });
});

describe("floating cards (redesign2-spec.md §4.5)", () => {
  const classes = (c: string) => c.split(/\s+/);

  it("gives the column no background or border, and bottom-aligns the cards", () => {
    for (const mode of ["inline", "drawer"] as const) {
      const c = classes(RIGHT_COLUMN_MODE_CLASS[mode]);
      expect(c.some((x) => x.startsWith("border")), mode).toBe(false);
      expect(c.some((x) => x.startsWith("bg-[")), mode).toBe(false);
    }
    expect(classes(RIGHT_COLUMN_MODE_CLASS.inline)).toEqual(expect.arrayContaining(["flex", "flex-col", "justify-end", "gap-4"]));
    expect(classes(RIGHT_COLUMN_MODE_CLASS.drawer)).toContain("justify-end");
  });

  it("lets clicks through the drawer except on the cards", () => {
    expect(classes(RIGHT_COLUMN_MODE_CLASS.drawer)).toContain("pointer-events-none");
    expect(classes(slotClass("drawer", "lower", true))).toContain("[&>*]:pointer-events-auto");
    expect(classes(slotClass("inline", "lower", true))).not.toContain("[&>*]:pointer-events-auto");
  });

  it("makes the phone sheet opaque, so no text shows or takes clicks between its cards", () => {
    const sheet = classes(RIGHT_COLUMN_MODE_CLASS.sheet);
    expect(sheet).toContain("bg-[var(--editor-bg)]");
    expect(sheet).not.toContain("pointer-events-none");
    expect(sheet.some((x) => x.startsWith("border")), "sheet").toBe(false);
  });

  it("keeps the cards clear of the floating buttons, and drops the sheet when there are none", () => {
    expect(RIGHT_COLUMN_MODE_CLASS.sheet).toContain("bottom-[calc(var(--fab-clearance,0px)+env(safe-area-inset-bottom,0px))]");
    expect(RIGHT_COLUMN_MODE_CLASS.inline).toContain("var(--fab-clearance,0px)");
    expect(RIGHT_COLUMN_MODE_CLASS.drawer).toContain("var(--fab-clearance,0px)");
  });

  it("gives Tools its natural height (up to 60%) and the outline the rest when both are open", () => {
    expect(classes(slotClass("inline", "lower", true))).toEqual(expect.arrayContaining(["flex-none", "max-h-[60%]"]));
    expect(classes(slotClass("inline", "outline", true))).toEqual(expect.arrayContaining(["flex-initial", "min-h-0"]));
    // Alone, a card takes its natural height up to the column.
    expect(classes(slotClass("drawer", "lower", false))).not.toContain("max-h-[60%]");
    // The sheet scrolls as a whole; its cards stack at full height.
    expect(classes(slotClass("sheet", "outline", true))).toContain("flex-none");
  });

  it("names the slots the floating buttons focus", () => {
    expect(TOOLS_SLOT_ID).toBe("editor-tools-slot");
    expect(OUTLINE_SLOT_ID).toBe("editor-outline-slot");
  });
});

describe("columnCloseFocus", () => {
  it("returns focus to the button that reopens the closed panel", () => {
    expect(columnCloseFocus("outline")).toBe("outline");
    // Tools and Section notes share the lower slot; notes have no button of their own.
    expect(columnCloseFocus("lower")).toBe("tools");
  });
});
