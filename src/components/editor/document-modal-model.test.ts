import { describe, expect, it } from "vitest";
import { DOCUMENT_MODAL_TABS, escapeAction, isDocumentModalTab, modalReturnTarget, modalTitle, TAB_LABELS } from "./document-modal-model";

describe("document modal tabs", () => {
  it("lists Notes, Sources, Data, Suggestions and Workflows in order, each with a label", () => {
    expect(DOCUMENT_MODAL_TABS).toEqual(["notes", "sources", "data", "suggestions", "workflows"]);
    expect(DOCUMENT_MODAL_TABS.map((t) => TAB_LABELS[t])).toEqual(["Notes", "Sources", "Data", "Suggestions", "Workflows"]);
  });

  it("guards tab values", () => {
    for (const t of DOCUMENT_MODAL_TABS) expect(isDocumentModalTab(t)).toBe(true);
    expect(isDocumentModalTab("workflows")).toBe(true);
    expect(isDocumentModalTab("Workflows")).toBe(false);
    expect(isDocumentModalTab("Notes")).toBe(false);
    expect(isDocumentModalTab(null)).toBe(false);
    expect(isDocumentModalTab(1)).toBe(false);
  });
});

describe("escapeAction", () => {
  it("cancels a running dictation instead of closing the dialog", () => {
    expect(escapeAction(true)).toBe("cancel_dictation");
    expect(escapeAction(false)).toBe("close");
  });
});

describe("modalTitle", () => {
  it("shows the document's title, or Untitled document", () => {
    expect(modalTitle("  Grant for the library ")).toBe("Grant for the library");
    expect(modalTitle("   ")).toBe("Untitled document");
  });
});

describe("modalReturnTarget", () => {
  const el = (nodeName: string, isConnected = true) => ({ nodeName, isConnected });
  it("returns focus to the control that opened the dialog", () => {
    const opener = el("BUTTON");
    expect(modalReturnTarget(opener, el("BUTTON"))).toBe(opener);
  });
  it("falls back to the Sources button when the opener is gone or was the page", () => {
    const fallback = el("BUTTON");
    for (const opener of [el("BUTTON", false), el("BODY"), null, undefined]) expect(modalReturnTarget(opener, fallback)).toBe(fallback);
  });
  it("gives up when neither is on the page", () => {
    expect(modalReturnTarget(el("BUTTON", false), el("BUTTON", false))).toBeNull();
    expect(modalReturnTarget(null, null)).toBeNull();
  });
});
