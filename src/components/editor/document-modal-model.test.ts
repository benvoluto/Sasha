import { describe, expect, it } from "vitest";
import { deepLinkOpen, DOCUMENT_MODAL_TABS, escapeAction, isDocumentModalTab, modalReturnTarget, modalTitle, TAB_LABELS } from "./document-modal-model";

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

describe("deepLinkOpen", () => {
  const params = { notes: "notes", run: "run" };

  it("opens Notes on ?notes=1 and a run on ?run=<id>, keeping the rest of the query", () => {
    expect(deepLinkOpen("?notes=1", params)).toEqual({ open: { tab: "notes" }, strip: "" });
    expect(deepLinkOpen("?run=r1&x=2", params)).toEqual({ open: { tab: "workflows", runId: "r1" }, strip: "?x=2" });
  });

  it("prefers the run when both are there", () => {
    expect(deepLinkOpen("?notes=1&run=r1", params).open).toEqual({ tab: "workflows", runId: "r1" });
  });

  it("drops a parameter it can't use, and leaves an address without them alone", () => {
    expect(deepLinkOpen("?notes=0&run=", params)).toEqual({ open: null, strip: "" });
    expect(deepLinkOpen("?x=1", params)).toEqual({ open: null, strip: null });
    expect(deepLinkOpen("", params)).toEqual({ open: null, strip: null });
  });
});
