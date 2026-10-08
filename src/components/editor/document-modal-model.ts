// The document modal's tabs (PLAN §6.2). Pure and client-safe. Data joined in
// Phase 5 and Workflows in Phase 6; document-modal.tsx has a pane for each, and
// nothing else keys off the list.
//
// CONTRACT (Phase 4): owned by the notes-and-modal track; Workflows added by
// the workflows-ui track (phase6-spec.md §8.1).

export const DOCUMENT_MODAL_TABS = ["notes", "sources", "data", "suggestions", "workflows"] as const;
export type DocumentModalTab = (typeof DOCUMENT_MODAL_TABS)[number];

export const TAB_LABELS: Record<DocumentModalTab, string> = {
  notes: "Notes",
  sources: "Sources",
  data: "Data",
  suggestions: "Suggestions",
  workflows: "Workflows",
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
