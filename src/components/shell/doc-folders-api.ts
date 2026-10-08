// Typed fetch wrappers for the documents panel: the document folder routes and
// the document list/patch/delete/bulk routes. Shapes come from the shared
// contract (src/lib/documents/folders-contract.ts). Every wrapper throws an
// ApiRequestError carrying the route's plain-English `{ error }` message and
// the status (the panel shows a 409 folder-name clash inline).

import type {
  BulkDocumentsBody,
  BulkDocumentsResponse,
  DeleteDocFolderResponse,
  DocFolderListResponse,
  DocFolderResponse,
  DocumentFolder,
  DocumentListItem,
  DocumentListResponse,
} from "@/lib/documents/folders-contract";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers });
  } catch {
    throw new ApiRequestError("Couldn't reach Sasha. Check your connection.", 0);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiRequestError(body.error ?? fallback, res.status);
  return body;
}

/** GET /api/documents?{query} (query from listQuery). */
export async function fetchDocuments(query: string): Promise<DocumentListItem[]> {
  const body = await request<DocumentListResponse>(`/api/documents${query ? `?${query}` : ""}`, undefined, "Couldn't load documents.");
  return body.documents ?? [];
}

export async function fetchFolders(): Promise<DocumentFolder[]> {
  const body = await request<DocFolderListResponse>("/api/document-folders", undefined, "Couldn't load folders.");
  return body.folders ?? [];
}

/** The folder a document is filed in (null for the top level), or undefined when it can't be read. */
export async function fetchDocumentFolderId(id: string): Promise<string | null | undefined> {
  try {
    const body = await request<{ document?: { doc_folder_id?: string | null } }>(`/api/documents/${encodeURIComponent(id)}`, undefined, "");
    return body.document?.doc_folder_id ?? null;
  } catch {
    return undefined;
  }
}

export async function createFolder(name: string): Promise<DocumentFolder> {
  const body = await request<DocFolderResponse>("/api/document-folders", { method: "POST", body: JSON.stringify({ name }) }, "Couldn't create the folder.");
  return body.folder;
}

export async function renameFolder(id: string, name: string): Promise<DocumentFolder> {
  const body = await request<DocFolderResponse>(`/api/document-folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }, "Couldn't rename the folder.");
  return body.folder;
}

export async function deleteFolder(id: string): Promise<DeleteDocFolderResponse> {
  return request<DeleteDocFolderResponse>(`/api/document-folders/${encodeURIComponent(id)}`, { method: "DELETE" }, "Couldn't delete the folder.");
}

/**
 * Organizing and renaming from the panel. A move or archive leaves updated_at
 * alone server-side, so an editor open on the document doesn't see it as a
 * conflict; a title rename is a real edit (the panel never renames the open
 * document this way — it hands that to the editor's title field).
 */
export type DocumentPanelPatch = { title?: string; archived?: boolean; doc_folder_id?: string | null };

export async function patchDocument(id: string, patch: DocumentPanelPatch, fallback = "Couldn't update this document."): Promise<void> {
  await request<unknown>(`/api/documents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, fallback);
}

export async function deleteDocument(id: string): Promise<void> {
  await request<unknown>(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" }, "Couldn't delete this document.");
}

export async function bulkDocuments(body: BulkDocumentsBody): Promise<BulkDocumentsResponse> {
  return request<BulkDocumentsResponse>("/api/documents/bulk", { method: "POST", body: JSON.stringify(body) }, "Couldn't update those documents.");
}
