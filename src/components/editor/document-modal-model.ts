// The document modal's tabs (PLAN §6.2). Pure and client-safe. Data and
// Workflows join in Phases 5 and 6: add them to DOCUMENT_MODAL_TABS and give
// document-modal.tsx a pane for each; nothing else keys off the list.
//
// CONTRACT (Phase 4): owned by the notes-and-modal track.

export const DOCUMENT_MODAL_TABS = ["notes", "sources", "suggestions"] as const;
export type DocumentModalTab = (typeof DOCUMENT_MODAL_TABS)[number];

export const TAB_LABELS: Record<DocumentModalTab, string> = {
  notes: "Notes",
  sources: "Sources",
  suggestions: "Suggestions",
};

export const isDocumentModalTab = (v: unknown): v is DocumentModalTab => typeof v === "string" && (DOCUMENT_MODAL_TABS as readonly string[]).includes(v);

/** What Esc does in the dialog: while the Notes tab is dictating it cancels the dictation (and the dialog stays open); otherwise it closes. */
export function escapeAction(dictating: boolean): "cancel_dictation" | "close" {
  return dictating ? "cancel_dictation" : "close";
}

/** The dialog's heading: the document's title, or "Untitled document". */
export function modalTitle(documentTitle: string): string {
  return documentTitle.trim() || "Untitled document";
}
