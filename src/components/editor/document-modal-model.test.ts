import { describe, expect, it } from "vitest";
import { DOCUMENT_MODAL_TABS, escapeAction, isDocumentModalTab, modalTitle, TAB_LABELS } from "./document-modal-model";

describe("document modal tabs", () => {
  it("lists Notes, Sources and Suggestions in order, each with a label", () => {
    expect(DOCUMENT_MODAL_TABS).toEqual(["notes", "sources", "suggestions"]);
    expect(DOCUMENT_MODAL_TABS.map((t) => TAB_LABELS[t])).toEqual(["Notes", "Sources", "Suggestions"]);
  });

  it("guards tab values", () => {
    for (const t of DOCUMENT_MODAL_TABS) expect(isDocumentModalTab(t)).toBe(true);
    // Phases 5 and 6 add these; until then they aren't tabs.
    expect(isDocumentModalTab("data")).toBe(false);
    expect(isDocumentModalTab("workflows")).toBe(false);
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
