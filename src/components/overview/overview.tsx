"use client";

// The documents overview at "/" (redesign3-spec.md §2, docs/documents.png):
// the team's documents as a grid of cards, the document folders as tiles
// below them, and the Notes tab. Documents are opened, renamed, filed (menu,
// drag onto a folder, or the Select bar), archived, restored and deleted here;
// new ones start blank ("New") or from a type (the Doc Gallery).
//
// The tab and view live in the address (?tab=notes, ?folder=<uuid>,
// ?view=archived, kept with router.replace) so Back and reload return to them.
// Searching lists matches across every folder as one flat grid and hides the
// folder tiles. Document folders are not the Phase 2 source folders (those
// live in the library); see src/lib/documents/folders-contract.ts.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "@/components/icons";
import { findType, useDocumentTypes } from "@/components/editor/type-picker";
import { NotesTab } from "@/components/notes/notes-tab";
import { bulkDocuments, createFolder, deleteDocument, deleteFolder, patchDocument, renameFolder } from "@/components/shell/doc-folders-api";
import { NEW_DOCUMENT_PATH } from "@/lib/documents/card-text";
import type { BulkAction, DocumentFolder, DocumentListItem } from "@/lib/documents/folders-contract";
import { DocGalleryDialog } from "./doc-gallery-dialog";
import { DocumentCard, type CardMode } from "./document-card";
import { ArchivedTile, FolderDeleteConfirm, FolderMenu, FolderTile, NewFolderTile, type FolderMode } from "./folder-tiles";
import { FOCUS_RING, InlineNameInput } from "./inline-edit";
import { OverviewHeader, TAB_IDS } from "./overview-header";
import { OVERVIEW_GRID, OVERVIEW_GUTTER } from "./overview-layout";
import {
  allSelected as everySelected,
  belongsInView,
  errorMessage,
  ESCAPE_GUARD_SELECTOR,
  escapeAction,
  isFlatList,
  listQuery,
  missingNotice,
  neighborAfterRemoval,
  overviewHeading,
  overviewHref,
  parseOverviewParams,
  ROOT_VIEW,
  selectionReducer,
  type OverviewTab,
  type OverviewView,
} from "./overview-model";
import { SelectBar } from "./select-bar";
import { useOverviewLibrary } from "./use-overview-library";

const SEARCH_DEBOUNCE_MS = 250;
const GRID = OVERVIEW_GRID;
const GUTTER = OVERVIEW_GUTTER;

type RowState = { kind: "doc" | "folder"; id: string; mode: Exclude<CardMode | FolderMode, null> } | null;

/**
 * Where focus goes once an action re-renders the grid (the control that had it
 * is gone): a card's link or ⋯ button, a folder tile or its ⋯ button, the
 * Select button, an open confirm's Delete button, or main (nothing left).
 */
type FocusTarget =
  | { kind: "doc"; id: string | null }
  | { kind: "doc-menu"; id: string }
  | { kind: "folder"; id: string | null }
  | { kind: "folder-menu"; id: string }
  | { kind: "select" }
  | { kind: "confirm" };

function focusTargetElement(root: HTMLElement, target: FocusTarget, selectButton: HTMLElement | null): HTMLElement | null {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector);
  switch (target.kind) {
    case "doc":
      // In Select mode a card's control is its checkbox.
      return target.id ? (q(`[data-doc-link="${target.id}"]`) ?? q(`#doc-select-${CSS.escape(target.id)}`)) : null;
    case "doc-menu":
      return q(`[data-doc-menu="${target.id}"]`);
    case "folder":
      return target.id ? q(`[data-folder-open="${target.id}"]`) : q("[data-new-folder]");
    case "folder-menu":
      return q(`[data-folder-menu="${target.id}"]`);
    case "select":
      return selectButton;
    case "confirm":
      return q("[data-confirm-delete]");
  }
}

export function Overview() {
  const router = useRouter();
  const params = useSearchParams();
  const { tab, view } = parseOverviewParams(params);
  const catalog = useDocumentTypes();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selection, dispatchSelection] = useReducer(selectionReducer, []);
  const [row, setRow] = useState<RowState>(null);
  /** The card or folder (id) with a request running. */
  const [working, setWorking] = useState<string | null>(null);
  const [bulkWorking, setBulkWorking] = useState<BulkAction | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [focusAfter, setFocusAfter] = useState<FocusTarget | null>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const flat = isFlatList(view, search);
  const query = listQuery(view, search);
  const lib = useOverviewLibrary(query);
  const { docs, folders: loadedFolders, reload, removeDocs, patchDocs, upsertFolder, removeFolder, adjustFolderCounts } = lib;
  const folders = useMemo(() => loadedFolders ?? [], [loadedFolders]);
  const currentFolder: DocumentFolder | null = view.kind === "folder" ? (folders.find((f) => f.id === view.id) ?? null) : null;
  const archivedView = view.kind === "archived";

  // The search filters a beat behind typing.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput), searchInput ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const exitSelect = useCallback(() => {
    setSelecting(false);
    dispatchSelection({ type: "none" });
  }, []);

  const go = useCallback(
    (nextTab: OverviewTab, nextView: OverviewView) => {
      router.replace(overviewHref(nextTab, nextView), { scroll: false });
    },
    [router],
  );

  // A different grid: drop half-finished edits and the selection.
  useEffect(() => {
    setRow(null);
    setNewFolderOpen(false);
    setNotice(null);
    dispatchSelection({ type: "none" });
  }, [query]);

  // Select mode belongs to the Documents tab.
  useEffect(() => {
    if (tab !== "documents") setSelecting(false);
  }, [tab]);

  // Keep the selection to cards still shown.
  useEffect(() => {
    if (docs) dispatchSelection({ type: "retain", ids: docs.map((d) => d.id) });
  }, [docs]);

  // A folder deleted elsewhere (or a stale link): back to the top level.
  useEffect(() => {
    if (view.kind === "folder" && loadedFolders && !loadedFolders.some((f) => f.id === view.id)) go("documents", ROOT_VIEW);
  }, [view, loadedFolders, go]);

  // After an action removes or swaps the focused control (a card's menu, the
  // Select bar, a confirm), put focus somewhere sensible instead of leaving it
  // on <body>. Only when focus really was lost: if the person has moved on, it
  // stays where it is.
  useEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    const root = mainRef.current?.parentElement;
    const current = document.activeElement;
    if (!root || (current && current !== document.body && current.isConnected)) return;
    const el = focusTargetElement(root, focusAfter, selectRef.current);
    (el && !el.matches(":disabled") ? el : mainRef.current)?.focus();
  }, [focusAfter, docs, folders, row, selecting]);

  // Esc leaves Select mode (focus back on Select), except where something else
  // owns Esc: menus, dialogs, popovers and the inline fields.
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target instanceof Element ? e.target : null;
      if (escapeAction({ defaultPrevented: e.defaultPrevented, guarded: !!target?.closest(ESCAPE_GUARD_SELECTOR), selecting }) !== "exit-select") return;
      setSelecting(false);
      dispatchSelection({ type: "none" });
      selectRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selecting]);

  // --- Single-document actions --------------------------------------------------

  const renameDoc = async (doc: DocumentListItem, title: string): Promise<string | void> => {
    try {
      await patchDocument(doc.id, { title }, "Couldn't rename this document.");
      patchDocs([doc.id], { title });
      setRow(null);
      setFocusAfter({ kind: "doc-menu", id: doc.id });
    } catch (e) {
      return errorMessage(e, "Couldn't rename this document.");
    }
  };

  /** Folder count changes for moving these documents into `folderId`. */
  const countDeltas = (ids: readonly string[], folderId: string | null) => {
    const deltas: Record<string, number> = {};
    for (const d of docs ?? []) {
      if (!ids.includes(d.id) || d.doc_folder_id === folderId) continue;
      if (d.doc_folder_id) deltas[d.doc_folder_id] = (deltas[d.doc_folder_id] ?? 0) - 1;
      if (folderId) deltas[folderId] = (deltas[folderId] ?? 0) + 1;
    }
    return deltas;
  };

  const moveDocs = async (ids: string[], folderId: string | null) => {
    if (ids.length === 0) return;
    setNotice(null);
    setWorking(ids.length === 1 ? ids[0] : null);
    try {
      if (ids.length === 1) await patchDocument(ids[0], { doc_folder_id: folderId }, "Couldn't move this document.");
      else await bulkDocuments({ action: "move", ids, doc_folder_id: folderId });
      adjustFolderCounts(countDeltas(ids, folderId));
      if (belongsInView({ doc_folder_id: folderId }, view, flat)) {
        patchDocs(ids, { doc_folder_id: folderId });
        setFocusAfter({ kind: "doc-menu", id: ids[0] });
      } else {
        setFocusAfter({ kind: "doc", id: neighborAfterRemoval(docs?.map((d) => d.id) ?? [], ids) });
        removeDocs(ids);
      }
      reload();
    } catch (e) {
      setNotice(errorMessage(e, "Couldn't move this document."));
      setFocusAfter({ kind: "doc-menu", id: ids[0] });
    } finally {
      setWorking(null);
    }
  };

  /** Archive, restore or delete one document, then drop it from this grid. */
  const act = async (doc: DocumentListItem, action: "archive" | "unarchive" | "delete") => {
    setWorking(doc.id);
    setNotice(null);
    try {
      if (action === "delete") await deleteDocument(doc.id);
      else await patchDocument(doc.id, { archived: action === "archive" }, `Couldn't ${action} this document.`);
      setFocusAfter({ kind: "doc", id: neighborAfterRemoval(docs?.map((d) => d.id) ?? [], [doc.id]) });
      removeDocs([doc.id]);
      setRow(null);
      reload();
    } catch (e) {
      setNotice(errorMessage(e, `Couldn't ${action} this document.`));
      // A failed delete leaves its confirm open: focus back on its Delete button.
      setFocusAfter(action === "delete" ? { kind: "confirm" } : { kind: "doc-menu", id: doc.id });
    } finally {
      setWorking(null);
    }
  };

  // --- Folders --------------------------------------------------------------------

  const createFolderNamed = async (name: string): Promise<string | void> => {
    try {
      const folder = await createFolder(name);
      upsertFolder(folder);
      setNewFolderOpen(false);
      setFocusAfter({ kind: "folder", id: folder.id });
      reload();
    } catch (e) {
      return errorMessage(e, "Couldn't create the folder.");
    }
  };

  const renameFolderTo = async (folder: DocumentFolder, name: string): Promise<string | void> => {
    try {
      upsertFolder(await renameFolder(folder.id, name));
      setRow(null);
      setFocusAfter({ kind: "folder-menu", id: folder.id });
    } catch (e) {
      return errorMessage(e, "Couldn't rename the folder.");
    }
  };

  const deleteFolderNow = async (folder: DocumentFolder) => {
    setWorking(folder.id);
    setNotice(null);
    try {
      await deleteFolder(folder.id);
      const inside = view.kind === "folder" && view.id === folder.id;
      setFocusAfter({ kind: "folder", id: inside ? null : neighborAfterRemoval(folders.map((f) => f.id), [folder.id]) });
      removeFolder(folder.id);
      setRow(null);
      if (inside) go("documents", ROOT_VIEW);
      reload();
    } catch (e) {
      setNotice(errorMessage(e, "Couldn't delete the folder."));
      setFocusAfter({ kind: "confirm" });
    } finally {
      setWorking(null);
    }
  };

  // --- Bulk -------------------------------------------------------------------------

  /** Resolves true when the request went through, so the bar can keep its delete confirm open on a failure. */
  const runBulk = async (action: BulkAction, folderId?: string | null): Promise<boolean> => {
    if (selection.length === 0) return false;
    setBulkWorking(action);
    setNotice(null);
    try {
      const ids = [...selection];
      const target = folderId ?? null;
      const result = await bulkDocuments(action === "move" ? { action, ids, doc_folder_id: target } : { action, ids });
      if (action === "move") adjustFolderCounts(countDeltas(result.done, target));
      if (action === "move" && belongsInView({ doc_folder_id: target }, view, flat)) patchDocs(result.done, { doc_folder_id: target });
      else removeDocs(result.done);
      // Select mode stays on (Done or Esc leaves it); the finished ones drop out of the selection.
      dispatchSelection({ type: "prune", ids: result.done });
      setFocusAfter({ kind: "select" });
      reload();
      setNotice(missingNotice(result.missing.length));
      return true;
    } catch (e) {
      setNotice(errorMessage(e, "Couldn't update those documents."));
      // The button that ran it was disabled while it ran, which drops focus:
      // back to the delete confirm (it stays open) or the Select button.
      setFocusAfter(action === "delete" ? { kind: "confirm" } : { kind: "select" });
      return false;
    } finally {
      setBulkWorking(null);
    }
  };

  // --- Rendering --------------------------------------------------------------------

  const visibleIds = docs?.map((d) => d.id) ?? [];
  const heading = overviewHeading(tab, view, currentFolder?.name ?? null);
  const searching = search.trim() !== "";
  const emptyText = searching ? "No documents match." : archivedView ? "No archived documents." : view.kind === "folder" ? "This folder is empty." : null;

  const backBar = view.kind !== "root" && (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 pt-6 sm:pt-10 ${GUTTER}`}>
      <button
        type="button"
        onClick={() => go("documents", ROOT_VIEW)}
        className={`flex min-h-11 items-center gap-1.5 rounded-full px-2 text-[17px] font-medium text-[var(--action)] hover:bg-[var(--action-soft)] sm:min-h-9 ${FOCUS_RING}`}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden /> All documents
      </button>
      {currentFolder && row?.kind === "folder" && row.id === currentFolder.id && row.mode !== null && <h1 className="sr-only">{heading}</h1>}
      {currentFolder && row?.kind === "folder" && row.id === currentFolder.id && row.mode === "confirm" ? (
        <FolderDeleteConfirm
          folder={currentFolder}
          working={working === currentFolder.id}
          onConfirm={() => void deleteFolderNow(currentFolder)}
          onCancel={() => {
            setRow(null);
            setFocusAfter({ kind: "folder-menu", id: currentFolder.id });
          }}
          className="max-w-xl flex-1"
        />
      ) : currentFolder && row?.kind === "folder" && row.id === currentFolder.id && row.mode === "rename" ? (
        <InlineNameInput
          initial={currentFolder.name}
          label={`Rename folder ${currentFolder.name}`}
          onSave={(name) => renameFolderTo(currentFolder, name)}
          onCancel={() => {
            setRow(null);
            setFocusAfter({ kind: "folder-menu", id: currentFolder.id });
          }}
          className="w-full max-w-sm"
        />
      ) : (
        <div className="group flex min-w-0 items-center gap-1">
          {/* In a folder or the archive the visible heading is the page's h1 (one heading, not an sr-only twin). */}
          <h1 className="min-w-0 truncate text-[22px] text-[var(--card-title)]">{heading}</h1>
          {currentFolder && (
            <FolderMenu
              folder={currentFolder}
              working={working === currentFolder.id}
              onRename={() => setRow({ kind: "folder", id: currentFolder.id, mode: "rename" })}
              onAskDelete={() => setRow({ kind: "folder", id: currentFolder.id, mode: "confirm" })}
              className="opacity-100!"
            />
          )}
        </div>
      )}
    </div>
  );

  const documentsPanel = (
    <>
      {backBar}
      {(lib.error || notice) && (
        <p role="alert" className={`mt-4 text-[15px] text-red-700 dark:text-red-400 ${GUTTER}`}>
          {notice ?? lib.error}
        </p>
      )}
      <section aria-label="Documents" className={`${GUTTER} ${view.kind === "root" ? "pt-6 sm:pt-[76px]" : "pt-6"}`}>
        {docs === null && !lib.error && (
          <p role="status" className="flex items-center gap-2 text-[15px] text-[var(--card-sub)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </p>
        )}
        {docs && docs.length === 0 && emptyText && <p className="text-[16px] text-[var(--card-sub)]">{emptyText}</p>}
        {docs && docs.length === 0 && !emptyText && (
          <p className="flex flex-wrap items-center gap-x-2 text-[16px] text-[var(--card-sub)]">
            No documents yet.
            <Link href={NEW_DOCUMENT_PATH} className={`inline-flex min-h-11 items-center rounded-md font-medium text-[var(--action)] underline-offset-4 hover:underline sm:min-h-8 ${FOCUS_RING}`}>
              New document
            </Link>
          </p>
        )}
        {docs && docs.length > 0 && (
          <ul className={GRID}>
            {docs.map((d) => (
              <DocumentCard
                key={d.id}
                doc={d}
                type={findType(catalog.types, d.type_key)}
                archivedView={archivedView}
                folders={folders}
                mode={row?.kind === "doc" && row.id === d.id ? (row.mode as CardMode) : null}
                working={working === d.id}
                selecting={selecting}
                selected={selection.includes(d.id)}
                onToggleSelect={() => dispatchSelection({ type: "toggle", id: d.id })}
                onRename={() => setRow({ kind: "doc", id: d.id, mode: "rename" })}
                onRenameSave={(t) => renameDoc(d, t)}
                onRenameCancel={() => {
                  setRow(null);
                  setFocusAfter({ kind: "doc-menu", id: d.id });
                }}
                onMove={(folderId) => void moveDocs([d.id], folderId)}
                onArchiveToggle={() => void act(d, archivedView ? "unarchive" : "archive")}
                onAskDelete={() => setRow({ kind: "doc", id: d.id, mode: "confirm" })}
                onConfirmDelete={() => void act(d, "delete")}
                onCancelDelete={() => {
                  setRow(null);
                  setFocusAfter({ kind: "doc-menu", id: d.id });
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {view.kind === "root" && !flat && (
        <section aria-labelledby="overview-folders-title" className={`mt-12 ${GUTTER}`}>
          <h2 id="overview-folders-title" className="sr-only">
            Folders
          </h2>
          <ul className={GRID}>
            {folders.map((f) => (
              <FolderTile
                key={f.id}
                folder={f}
                mode={row?.kind === "folder" && row.id === f.id ? (row.mode as FolderMode) : null}
                working={working === f.id}
                onOpen={() => {
                  exitSelect();
                  go("documents", { kind: "folder", id: f.id });
                }}
                onDropDocument={(id) => void moveDocs([id], f.id)}
                onRename={() => setRow({ kind: "folder", id: f.id, mode: "rename" })}
                onRenameSave={(name) => renameFolderTo(f, name)}
                onRenameCancel={() => {
                  setRow(null);
                  setFocusAfter({ kind: "folder-menu", id: f.id });
                }}
                onAskDelete={() => setRow({ kind: "folder", id: f.id, mode: "confirm" })}
                onConfirmDelete={() => void deleteFolderNow(f)}
                onCancelDelete={() => {
                  setRow(null);
                  setFocusAfter({ kind: "folder-menu", id: f.id });
                }}
              />
            ))}
            <NewFolderTile
              editing={newFolderOpen}
              onStart={() => setNewFolderOpen(true)}
              onSave={createFolderNamed}
              onCancel={() => {
                setNewFolderOpen(false);
                setFocusAfter({ kind: "folder", id: null });
              }}
            />
            <ArchivedTile
              onOpen={() => {
                exitSelect();
                go("documents", { kind: "archived" });
              }}
            />
          </ul>
        </section>
      )}
    </>
  );

  return (
    <div className="min-h-dvh bg-[var(--page-bg)]">
      <OverviewHeader
        tab={tab}
        onTab={(t) => {
          if (t !== tab) go(t, ROOT_VIEW);
        }}
        search={searchInput}
        onSearch={setSearchInput}
        selecting={selecting}
        onToggleSelect={() => {
          if (selecting) exitSelect();
          else {
            setRow(null);
            setSelecting(true);
          }
        }}
        selectRef={selectRef}
        onOpenGallery={() => setGalleryOpen(true)}
      />
      <main ref={mainRef} id="main-content" tabIndex={-1} className={`outline-none ${selecting ? "pb-40" : "pb-32"}`}>
        {(tab === "notes" || view.kind === "root") && <h1 className="sr-only">{heading}</h1>}
        <div role="tabpanel" id={TAB_IDS.documents.panel} aria-labelledby={TAB_IDS.documents.tab} hidden={tab !== "documents"}>
          {tab === "documents" && documentsPanel}
        </div>
        <div role="tabpanel" id={TAB_IDS.notes.panel} aria-labelledby={TAB_IDS.notes.tab} hidden={tab !== "notes"} className="pt-6 sm:pt-[76px]">
          {tab === "notes" && <NotesTab query={search} />}
        </div>
      </main>

      {selecting && tab === "documents" && (
        <SelectBar
          count={selection.length}
          allSelected={everySelected(selection, visibleIds)}
          archivedView={archivedView}
          folders={folders}
          working={bulkWorking}
          onSelectAll={() => dispatchSelection({ type: "all", ids: visibleIds })}
          onSelectNone={() => dispatchSelection({ type: "none" })}
          onAction={runBulk}
          onDone={() => {
            exitSelect();
            selectRef.current?.focus();
          }}
        />
      )}

      <DocGalleryDialog open={galleryOpen} onOpenChange={setGalleryOpen} folderId={view.kind === "folder" ? view.id : null} />
    </div>
  );
}
