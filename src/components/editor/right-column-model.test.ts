import { describe, expect, it } from "vitest";
import {
  CLOSED_COLUMN,
  closeLower,
  closeOutline,
  columnCloseFocus,
  isColumnOpen,
  openNotes,
  RIGHT_COLUMN_MODE_CLASS,
  rightColumnMode,
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

  it("closes each half on its own", () => {
    const s: RightColumnState = { outline: true, lower: "notes" };
    expect(closeLower(s)).toEqual({ outline: true, lower: null });
    expect(closeOutline(s)).toEqual({ outline: false, lower: "notes" });
    expect(isColumnOpen(closeOutline(closeLower(s)))).toBe(false);
  });

  it("does not mutate its input", () => {
    const s: RightColumnState = { outline: false, lower: null };
    toggleOutline(s);
    toggleTools(s);
    openNotes(s);
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

describe("columnCloseFocus", () => {
  it("returns focus to the button that reopens the closed panel", () => {
    expect(columnCloseFocus("outline")).toBe("outline");
    // Tools and Section notes share the lower slot; notes have no button of their own.
    expect(columnCloseFocus("lower")).toBe("tools");
  });
});
