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

/**
 * Where focus goes when the dialog closes: the control that opened it while it
 * is still on the page (the header's Sources button, the helper's "upload
 * sources"), else the fallback (the helper may have dismissed itself).
 */
export function modalReturnTarget<T extends { isConnected: boolean; nodeName: string }>(opener: T | null | undefined, fallback: T | null | undefined): T | null {
  for (const el of [opener, fallback]) if (el?.isConnected && el.nodeName !== "BODY") return el;
  return null;
}

/**
 * What a deep link to the editor opens (redesign3-spec.md §1): `?run=<id>`
 * the Workflows tab on that run, `?notes=1` the Notes tab, anything else
 * nothing. A run wins when both are there. `strip` is the query to put back in
 * the address (both parameters dropped, the rest kept), so a reload doesn't
 * open the dialog again.
 */
export function deepLinkOpen(search: string, params: { notes: string; run: string }): { open: { tab: "notes" } | { tab: "workflows"; runId: string } | null; strip: string | null } {
  const q = new URLSearchParams(search);
  const runId = q.get(params.run)?.trim();
  const notes = q.get(params.notes);
  if (!q.has(params.run) && !q.has(params.notes)) return { open: null, strip: null };
  q.delete(params.run);
  q.delete(params.notes);
  const rest = q.toString();
  const open = runId ? ({ tab: "workflows", runId } as const) : notes === "1" ? ({ tab: "notes" } as const) : null;
  return { open, strip: rest ? `?${rest}` : "" };
}
