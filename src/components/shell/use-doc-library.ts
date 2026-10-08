"use client";

// The documents panel's data: the documents in the current view and the
// team's document folders. It refetches when the panel opens, when the view or
// search changes, when the open document changes (a new one just got its first
// save) and whenever the panel calls reload() after a mutation. Local edits
// (removing or patching rows) apply immediately so the list doesn't wait on a
// refetch.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentFolder, DocumentListItem } from "@/lib/documents/folders-contract";
import { fetchDocuments, fetchFolders } from "./doc-folders-api";
import { errorMessage } from "./docs-panel-model";

export function useDocLibrary({ open, query, activeId }: { open: boolean; /** From listQuery(). */ query: string; activeId: string | null }) {
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [folders, setFolders] = useState<DocumentFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /** The query the shown rows answer, so a new view shows "Loading…" instead of the old view's rows. */
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    const ticket = ++latest.current;
    void (async () => {
      const [docsResult, foldersResult] = await Promise.allSettled([fetchDocuments(query), fetchFolders()]);
      if (ticket !== latest.current) return;
      if (docsResult.status === "fulfilled") {
        setDocs(docsResult.value);
        setLoadedQuery(query);
      }
      if (foldersResult.status === "fulfilled") setFolders(foldersResult.value);
      const failed = docsResult.status === "rejected" ? docsResult.reason : foldersResult.status === "rejected" ? foldersResult.reason : null;
      setError(failed ? errorMessage(failed, "Couldn't load documents.") : null);
    })();
  }, [open, query, activeId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const removeDocs = useCallback((ids: readonly string[]) => {
    const drop = new Set(ids);
    setDocs((list) => list?.filter((d) => !drop.has(d.id)) ?? null);
  }, []);

  const patchDocs = useCallback((ids: readonly string[], patch: Partial<DocumentListItem>) => {
    const hit = new Set(ids);
    setDocs((list) => list?.map((d) => (hit.has(d.id) ? { ...d, ...patch } : d)) ?? null);
  }, []);

  const upsertFolder = useCallback((folder: DocumentFolder) => {
    setFolders((list) => {
      const rest = (list ?? []).filter((f) => f.id !== folder.id);
      return [...rest, folder].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    });
  }, []);

  const removeFolder = useCallback((id: string) => setFolders((list) => list?.filter((f) => f.id !== id) ?? null), []);

  return {
    /** Null while the current view's first load is running. */
    docs: loadedQuery === query ? docs : null,
    folders,
    error,
    setError,
    reload,
    removeDocs,
    patchDocs,
    upsertFolder,
    removeFolder,
  };
}
