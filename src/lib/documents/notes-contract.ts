// The document scratchpad (PLAN §6.2 Notes, decisions 15–18). Notes are saved
// through the document's own PATCH with the same optimistic concurrency as the
// body (use-document.ts queues both in one save), so a notes save and a body
// save never race each other. Client-safe.
//
// CONTRACT (Phase 4): owned by the notes-and-modal track.

/** Longest notes PATCH /api/documents/[id] accepts (characters). */
export const MAX_DOCUMENT_NOTES = 200_000;
