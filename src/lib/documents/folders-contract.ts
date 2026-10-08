// Document folders: the request and response shapes shared by the API routes
// (src/app/api/document-folders, src/app/api/documents) and the documents
// panel (src/components/shell). Folders hold DOCUMENTS, one level deep, and are
// owned by a team. They are not the Phase 2 source folders (the `folder` table,
// src/lib/sources/store.ts), which organise the sources library; a document's
// `folder_id` column is that Phase 2 link, and its document folder is the
// separate `doc_folder_id`.
//
// Moving a document between folders, like archiving it, is not an edit: it
// leaves `updated_at` alone, so an editor open on the document doesn't see the
// move as someone else's save.

import { z } from "zod";

/** The `folder` query value for documents that are in no folder (the panel's top level). */
export const DOC_FOLDER_ROOT = "root";

export const DOC_FOLDER_NAME_MAX = 120;
/** The most documents one bulk request may touch. */
export const BULK_MAX = 200;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid id.");

export const DocFolderName = z.string().trim().min(1, "Name the folder.").max(DOC_FOLDER_NAME_MAX);

/** A document folder as the API returns it. */
export type DocumentFolder = {
  id: string;
  name: string;
  /** Non-archived documents in the folder. */
  document_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** One row of GET /api/documents (the store's DocumentSummary, as JSON). */
export type DocumentListItem = {
  id: string;
  title: string;
  type_key: string | null;
  excerpt: string;
  archived: boolean;
  doc_folder_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

// --- GET /api/documents?q=&archived=1&folder=<uuid|root> ----------------------
// `folder` omitted: every folder (search, the archived view, older callers).
// `folder=root`: documents in no folder. `folder=<uuid>`: that folder's documents.
export const DocumentListFolderParam = z.union([z.literal(DOC_FOLDER_ROOT), uuid]);
export type DocumentListResponse = { documents: DocumentListItem[] };

// --- GET /api/document-folders -------------------------------------------------
export type DocFolderListResponse = { folders: DocumentFolder[] };

// --- POST /api/document-folders ------------------------------------------------
export const CreateDocFolderBody = z.object({ name: DocFolderName });
export type CreateDocFolderBody = z.infer<typeof CreateDocFolderBody>;
/** POST (201) and PATCH both answer with the folder. */
export type DocFolderResponse = { folder: DocumentFolder };

/** The plain-English 400 message for a folder body that failed CreateDocFolderBody / UpdateDocFolderBody. */
export function docFolderNameError(error: z.ZodError): string {
  return error.issues.some((i) => i.code === "too_big")
    ? `Keep folder names to ${DOC_FOLDER_NAME_MAX} characters or fewer.`
    : "Name the folder.";
}

// --- PATCH /api/document-folders/[id] ------------------------------------------
export const UpdateDocFolderBody = z.object({ name: DocFolderName });
export type UpdateDocFolderBody = z.infer<typeof UpdateDocFolderBody>;

// --- DELETE /api/document-folders/[id] -----------------------------------------
// The folder's documents (archived ones too) move to the top level.
export type DeleteDocFolderResponse = { deleted: true; moved: number };

// --- PATCH /api/documents/[id] -------------------------------------------------
// Adds to the existing patch body: `doc_folder_id` (a folder of the caller's
// team, or null for the top level). An unknown folder is a 400.
export const DocFolderIdField = uuid.nullable();

// --- POST /api/documents/bulk --------------------------------------------------
const BulkIds = z.array(uuid).min(1).max(BULK_MAX);
export const BulkDocumentsBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive"), ids: BulkIds }),
  z.object({ action: z.literal("restore"), ids: BulkIds }),
  z.object({ action: z.literal("delete"), ids: BulkIds }),
  z.object({ action: z.literal("move"), ids: BulkIds, doc_folder_id: DocFolderIdField }),
]);
export type BulkDocumentsBody = z.infer<typeof BulkDocumentsBody>;
export type BulkAction = BulkDocumentsBody["action"];
/** `done`: ids changed. `missing`: ids not found in the caller's team (left alone). */
export type BulkDocumentsResponse = { action: BulkAction; done: string[]; missing: string[] };

/** The error body every route above returns with a 4xx/5xx. */
export type ApiError = { error: string };
