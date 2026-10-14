import { describe, expect, it } from "vitest";
import {
  AGENTS_HEADING_ID,
  CLOSED_COLUMN,
  columnCloseFocus,
  columnReducer,
  isColumnOpen,
  openFocusId,
  OUTLINE_HEADING_ID,
  overlaysText,
  panelsKey,
  panelsOf,
  readPanels,
  rightColumnMode,
  writePanels,
  type RightColumnState,
} from "./right-column-model";

/** An in-memory Storage; `broken` makes every access throw, like a blocked localStorage. */
function memoryStorage(broken = false) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => {
      if (broken) throw new Error("SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
  };
}

describe("columnReducer", () => {
  it("starts closed", () => {
    expect(isColumnOpen(CLOSED_COLUMN)).toBe(false);
  });

  it("opens and closes Agents and Outline independently", () => {
    let s = columnReducer(CLOSED_COLUMN, { type: "open", slot: "lower" });
    expect(s).toEqual({ outline: false, lower: "agents" });
    s = columnReducer(s, { type: "open", slot: "outline" });
    expect(s).toEqual({ outline: true, lower: "agents" });
    expect(columnReducer(s, { type: "close", slot: "lower" })).toEqual({ outline: true, lower: null });
    expect(columnReducer(s, { type: "close", slot: "outline" })).toEqual({ outline: false, lower: "agents" });
  });

  it("lets Section notes and Check take the Agents place, and Agents take it back", () => {
    const notes = columnReducer({ outline: true, lower: "agents" }, { type: "notes" });
    expect(notes).toEqual({ outline: true, lower: "notes" });
    const check = columnReducer(notes, { type: "check" });
    expect(check).toEqual({ outline: true, lower: "check" });
    expect(columnReducer(check, { type: "open", slot: "lower" })).toEqual({ outline: true, lower: "agents" });
    // Their close puts the Agents button back.
    expect(columnReducer(check, { type: "close", slot: "lower" })).toEqual({ outline: true, lower: null });
    expect(columnCloseFocus("lower")).toBe("agents");
  });

  it("closes everything from the drawer or sheet", () => {
    expect(columnReducer({ outline: true, lower: "notes" }, { type: "close_all" })).toEqual(CLOSED_COLUMN);
  });

  it("restores the remembered panels", () => {
    expect(columnReducer(CLOSED_COLUMN, { type: "restore", panels: { agents: true, outline: false } })).toEqual({ outline: false, lower: "agents" });
    expect(columnReducer(CLOSED_COLUMN, { type: "restore", panels: { agents: false, outline: true } })).toEqual({ outline: true, lower: null });
  });

  it("does not mutate its input", () => {
    const s: RightColumnState = { outline: false, lower: null };
    columnReducer(s, { type: "open", slot: "outline" });
    columnReducer(s, { type: "notes" });
    expect(s).toEqual({ outline: false, lower: null });
  });
});

describe("focus", () => {
  it("opens onto the card's heading and closes onto the button in its place", () => {
    expect(openFocusId("lower")).toBe(AGENTS_HEADING_ID);
    expect(openFocusId("outline")).toBe(OUTLINE_HEADING_ID);
    expect(columnCloseFocus("outline")).toBe("outline");
  });
});

describe("remembered panels", () => {
  it("round-trips per document under sasha.panels.<id>", () => {
    const st = memoryStorage();
    writePanels(st, "d1", { agents: true, outline: false });
    expect(st.data.get("sasha.panels.d1")).toBe('{"agents":true,"outline":false}');
    expect(readPanels(st, "d1")).toEqual({ agents: true, outline: false });
    expect(readPanels(st, "d2")).toBeNull();
    expect(panelsKey("abc")).toBe("sasha.panels.abc");
  });

  it("never remembers or restores a new, unsaved document", () => {
    const st = memoryStorage();
    writePanels(st, null, { agents: true, outline: true });
    expect(st.data.size).toBe(0);
    expect(readPanels(st, null)).toBeNull();
  });

  it("survives blocked storage and junk values", () => {
    const broken = memoryStorage(true);
    expect(() => writePanels(broken, "d1", { agents: true, outline: true })).not.toThrow();
    expect(readPanels(broken, "d1")).toBeNull();
    expect(readPanels(null, "d1")).toBeNull();
    const st = memoryStorage();
    st.data.set(panelsKey("d1"), "{not json");
    expect(readPanels(st, "d1")).toBeNull();
    st.data.set(panelsKey("d1"), '"yes"');
    expect(readPanels(st, "d1")).toBeNull();
    st.data.set(panelsKey("d1"), '{"agents":"yes","outline":true}');
    expect(readPanels(st, "d1")).toEqual({ agents: false, outline: true });
  });

  it("stores Agents as open only while Agents itself shows", () => {
    expect(panelsOf({ outline: true, lower: "agents" })).toEqual({ agents: true, outline: true });
    expect(panelsOf({ outline: false, lower: "notes" })).toEqual({ agents: false, outline: false });
    expect(panelsOf({ outline: false, lower: "check" })).toEqual({ agents: false, outline: false });
  });
});

describe("rightColumnMode", () => {
  it("is a bottom sheet on phones whatever the container", () => {
    expect(rightColumnMode(2000, 639)).toBe("sheet");
    expect(rightColumnMode(300, 375)).toBe("sheet");
  });

  it("sits inline when the editor card is as wide as in a 1280px window", () => {
    expect(rightColumnMode(1152, 1280)).toBe("inline");
    expect(rightColumnMode(1800, 1920)).toBe("inline");
  });

  it("is a drawer below that on wider viewports", () => {
    expect(rightColumnMode(1151, 1240)).toBe("drawer");
    expect(rightColumnMode(700, 768)).toBe("drawer");
    expect(rightColumnMode(500, 640)).toBe("drawer");
  });

  it("covers the text only with a card open outside the inline column", () => {
    const open: RightColumnState = { outline: true, lower: null };
    expect(overlaysText("inline", open)).toBe(false);
    expect(overlaysText("drawer", open)).toBe(true);
    expect(overlaysText("sheet", open)).toBe(true);
    expect(overlaysText("sheet", CLOSED_COLUMN)).toBe(false);
  });
});
