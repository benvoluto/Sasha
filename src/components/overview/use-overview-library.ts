"use client";

// The overview's data: the documents in the current view and the team's
// document folders. It refetches when the view or search changes, when the
// window regains focus (another tab may have filed or renamed something), when
// a document save lands (the editor's last save is still in flight when the
// person comes back here) and whenever the overview calls reload() after a change. Local edits (removing
// or patching cards, folder counts) apply at once, so the grid doesn't wait on
// a refetch.

import { useCallback, useEffect, useRef, useState } from "react";
import { onDocumentSaved } from "@/components/editor/document-saved";
import { fetchDocuments, fetchFolders } from "@/components/shell/doc-folders-api";
import type { DocumentFolder, DocumentListItem } from "@/lib/documents/folders-contract";
import { errorMessage } from "./overview-model";

const byName = (a: DocumentFolder, b: DocumentFolder) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function useOverviewLibrary(/** From listQuery(). */ query: string) {
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [folders, setFolders] = useState<DocumentFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /** The query the shown cards answer, so a new view shows "Loading…" instead of the old view's cards. */
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    void (async () => {
      const [docsResult, foldersResult] = await Promise.allSettled([fetchDocuments(query), fetchFolders()]);
      if (ticket !== latest.current) return;
      if (docsResult.status === "fulfilled") {
        setDocs(docsResult.value);
        setLoadedQuery(query);
      }
      if (foldersResult.status === "fulfilled") setFolders([...foldersResult.value].sort(byName));
      const failed = docsResult.status === "rejected" ? docsResult.reason : foldersResult.status === "rejected" ? foldersResult.reason : null;
      setError(failed ? errorMessage(failed, "Couldn't load documents.") : null);
    })();
  }, [query, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "hidden") reload();
    };
    window.addEventListener("focus", onFocus);
    // Saves that land together (body then notes) bring one refetch.
    let timer: number | null = null;
    const offSaved = onDocumentSaved(() => {
      if (timer === null) timer = window.setTimeout(() => {
        timer = null;
        reload();
      }, 150);
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      offSaved();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [reload]);

  const removeDocs = useCallback((ids: readonly string[]) => {
    const drop = new Set(ids);
    setDocs((list) => list?.filter((d) => !drop.has(d.id)) ?? null);
  }, []);

  const patchDocs = useCallback((ids: readonly string[], patch: Partial<DocumentListItem>) => {
    const hit = new Set(ids);
    setDocs((list) => list?.map((d) => (hit.has(d.id) ? { ...d, ...patch } : d)) ?? null);
  }, []);

  const upsertFolder = useCallback((folder: DocumentFolder) => {
    setFolders((list) => [...(list ?? []).filter((f) => f.id !== folder.id), folder].sort(byName));
  }, []);

  const removeFolder = useCallback((id: string) => setFolders((list) => list?.filter((f) => f.id !== id) ?? null), []);

  /** Add `delta` to folder counts (a move in or out) until the next refetch brings the real numbers. */
  const adjustFolderCounts = useCallback((deltas: Record<string, number>) => {
    setFolders((list) => list?.map((f) => (deltas[f.id] ? { ...f, document_count: Math.max(0, f.document_count + deltas[f.id]) } : f)) ?? null);
  }, []);

  return {
    /** Null while the current view's first load is running. */
    docs: loadedQuery === query ? docs : null,
    folders,
    error,
    reload,
    removeDocs,
    patchDocs,
    upsertFolder,
    removeFolder,
    adjustFolderCounts,
  };
}
