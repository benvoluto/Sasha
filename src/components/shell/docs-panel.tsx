"use client";

// The documents/folders panel that slides in from the left of the app frame.
// It lists the team's documents and document folders (one level deep), and is
// where documents are opened, started (blank or from a type), renamed, filed,
// archived, restored and deleted, one at a time or in Select mode.
//
// Geometry (spec §5): at ≥1024px it sits in the page flow and pushes the page
// aside (an outer wrapper animates its width while the panel keeps a fixed
// width, so text doesn't reflow mid-slide); below that it floats over the page
// as a modal dialog with a scrim, and the page behind it is inert (AppShell,
// which also keeps Tab inside it).
// Closed, it is inert, aria-hidden and invisible, so it is out of the tab order.
//
// Document folders are not the Phase 2 source folders (those live in the
// library); see src/lib/documents/folders-contract.ts.

import { useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { Archive, ArrowLeft, DocFolderIcon, DocsIcon, FileText, Loader2, NewDocFolderIcon, NewDocIcon, Search, SelectIcon, TypesIcon, X } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createDocumentOfType, findType, TypeGallery, useDocumentTypes } from "@/components/editor/type-picker";
import type { BulkAction, DocumentFolder, DocumentListItem } from "@/lib/documents/folders-contract";
import { activeDocumentAtom } from "./active-document";
import { DocsBulkBar } from "./docs-bulk-bar";
import { bulkDocuments, createFolder, deleteDocument, deleteFolder, fetchDocumentFolderId, patchDocument, renameFolder } from "./doc-folders-api";
import {
  allSelected as everySelected,
  belongsInView,
  displayTitle,
  errorMessage,
  ESCAPE_GUARD_SELECTOR,
  escapeAction,
  isFlatList,
  listQuery,
  neighborAfterRemoval,
  ROOT_VIEW,
  selectionReducer,
  type PanelView,
} from "./docs-panel-model";
import { DocumentRow, FOCUS_RING, FolderDeleteConfirm, FolderMenu, FolderRow, InlineNameInput, type RowMode } from "./docs-panel-rows";
import { useDocLibrary } from "./use-doc-library";

// Wide screens: about 39% of the window with the rail (the mockup), see --docs-panel-w in globals.css.
// As an overlay the panel stops 3rem short of the right edge, so a strip of the
// scrim always shows and can be tapped to close it, even on the narrowest phone.
const PANEL_W = "w-[min(420px,calc(100vw-56px-3rem))] sm:w-[min(420px,calc(100vw-72px-3rem))] lg:w-[var(--docs-panel-w)]";
const SECTION_HEAD = "flex items-center gap-2 text-[17px] font-medium uppercase sm:text-[19px] text-[var(--panel-head)]";
const BLUE_BUTTON = `flex h-10 items-center gap-1.5 rounded-lg px-1.5 text-[16px] font-semibold sm:px-2 sm:text-[17px] text-[var(--action)] hover:bg-[var(--action-soft)] aria-pressed:bg-[var(--action-soft)] data-[state=open]:bg-[var(--action-soft)] ${FOCUS_RING}`;

type RowState = { kind: "doc" | "folder"; id: string; mode: Exclude<RowMode, null> } | null;
/** The inline "new folder" field, and the documents to file in the new folder once it exists. */
type NewFolderState = { moveIds: string[] } | null;
/**
 * Where focus goes once a row action re-renders the list (the control that had
 * it is gone): a document's link or ⋯ button, a folder's row or ⋯ button, the
 * Select button, or the heading. A null id means the heading (the list emptied).
 */
type FocusTarget =
  | { kind: "doc"; id: string | null }
  | { kind: "doc-menu"; id: string }
  | { kind: "folder"; id: string | null }
  | { kind: "folder-menu"; id: string }
  | { kind: "select" }
  /** The open inline confirm's Delete button (a delete that failed). */
  | { kind: "confirm" };

/** The element for a focus target, inside the panel. */
function focusTargetElement(panel: HTMLElement, target: FocusTarget, selectButton: HTMLElement | null): HTMLElement | null {
  const q = (selector: string) => panel.querySelector<HTMLElement>(selector);
  switch (target.kind) {
    case "doc":
      // In Select mode the row's control is its checkbox.
      return target.id ? (q(`[data-doc-link="${target.id}"]`) ?? q(`#doc-select-${CSS.escape(target.id)}`)) : null;
    case "doc-menu":
      return q(`[data-doc-menu="${target.id}"]`);
    case "folder":
      return target.id ? q(`[data-folder-open="${target.id}"]`) : null;
    case "folder-menu":
      return q(`[data-folder-menu="${target.id}"]`);
    case "select":
      return selectButton;
    case "confirm":
      return q("[data-confirm-delete]");
  }
}

export function DocsPanel({
  open,
  wide,
  animate,
  headingRef,
  onClose,
}: {
  open: boolean;
  /** ≥1024px: push the page aside instead of floating over it. */
  wide: boolean;
  /** False until after the first paint, so a panel remembered open doesn't slide in on load. */
  animate: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** restoreFocus false: something else takes focus (a followed link, the editor's title). */
  onClose: (opts?: { restoreFocus?: boolean }) => void;
}) {
  const router = useRouter();
  const active = useAtomValue(activeDocumentAtom);
  const activeId = active?.id ?? null;
  const catalog = useDocumentTypes();

  const [view, setView] = useState<PanelView>(ROOT_VIEW);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selection, dispatchSelection] = useReducer(selectionReducer, []);
  const [row, setRow] = useState<RowState>(null);
  /** The row (document or folder id) with a request running. */
  const [working, setWorking] = useState<string | null>(null);
  const [bulkWorking, setBulkWorking] = useState<BulkAction | null>(null);
  const [newFolder, setNewFolder] = useState<NewFolderState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [focusAfter, setFocusAfter] = useState<FocusTarget | null>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);

  const flat = isFlatList(search, archived);
  const query = listQuery(view, search, archived);
  const lib = useDocLibrary({ open, query, activeId });
  const { docs, folders: loadedFolders, reload, removeDocs, patchDocs, upsertFolder, removeFolder } = lib;
  const folders = useMemo(() => loadedFolders ?? [], [loadedFolders]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const currentFolder: DocumentFolder | null = view.kind === "folder" ? (folderById.get(view.id) ?? null) : null;

  // The search box filters as you type, a beat behind (as the old switcher did).
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput), searchInput ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // A different list: drop half-finished row edits and the selection.
  useEffect(() => {
    setRow(null);
    setNewFolder(null);
    dispatchSelection({ type: "none" });
  }, [query]);

  // Keep the selection to rows still listed.
  useEffect(() => {
    if (docs) dispatchSelection({ type: "retain", ids: docs.map((d) => d.id) });
  }, [docs]);

  // A folder deleted elsewhere: back to the top level.
  useEffect(() => {
    if (view.kind === "folder" && loadedFolders && !loadedFolders.some((f) => f.id === view.id)) setView(ROOT_VIEW);
  }, [view, loadedFolders]);

  // The first time the panel opens on a filed document, start inside its folder.
  const startedFor = useRef(false);
  useEffect(() => {
    if (!open || startedFor.current) return;
    startedFor.current = true;
    if (!activeId) return;
    let cancelled = false;
    void fetchDocumentFolderId(activeId).then((folderId) => {
      if (!cancelled && folderId) setView((v) => (v.kind === "root" ? { kind: "folder", id: folderId, name: "" } : v));
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeId]);

  // After an action removes or swaps the focused control (a ⋯ menu's row, the
  // bulk bar, a confirm), put focus somewhere sensible in the panel instead of
  // leaving it on <body>. Only when focus really was lost: if the person has
  // moved on (clicked elsewhere, the editor took it), it stays where it is.
  useEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    const panel = document.getElementById("docs-panel");
    const current = document.activeElement;
    if (!panel || (current && current !== document.body && current.isConnected)) return;
    const el = focusTargetElement(panel, focusAfter, selectButtonRef.current);
    (el && !el.matches(":disabled") ? el : headingRef.current)?.focus();
  }, [focusAfter, docs, folders, row, selecting, headingRef]);

  const exitSelect = useCallback(() => {
    setSelecting(false);
    dispatchSelection({ type: "none" });
  }, []);

  // Esc closes the panel (or first leaves Select mode), except where something
  // else owns Esc: menus, dialogs, popovers and the inline fields.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target instanceof Element ? e.target : null;
      // Esc anywhere on the page closes the panel, pushed or overlaid. Surfaces
      // with their own Esc (the drawer/sheet right column, the link form, the
      // inline fields) call preventDefault or sit under ESCAPE_GUARD_SELECTOR.
      const action = escapeAction({ defaultPrevented: e.defaultPrevented, guarded: !!target?.closest(ESCAPE_GUARD_SELECTOR), selecting });
      if (action === "exit-select") exitSelect();
      else if (action === "close") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, selecting, exitSelect, onClose]);

  /** Following a link: the overlay gets out of the way; the push panel stays. */
  const afterNavigate = useCallback(() => {
    if (!wide) onClose({ restoreFocus: false });
  }, [wide, onClose]);

  const leaveOpenDocument = useCallback(() => {
    router.push(`/?n=${Date.now()}`);
    afterNavigate();
  }, [router, afterNavigate]);

  // --- Single-document actions --------------------------------------------------

  const focusEditorTitle = () => {
    if (!wide) onClose({ restoreFocus: false });
    // After the overlay closes the page is no longer inert.
    window.setTimeout(
      () => {
        const input = document.getElementById("doc-title");
        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
          input.focus();
          input.select();
        }
      },
      wide ? 0 : 60,
    );
  };

  const renameDoc = async (doc: DocumentListItem, title: string): Promise<string | void> => {
    try {
      await patchDocument(doc.id, { title }, "Couldn't rename this document.");
      patchDocs([doc.id], { title });
      setRow(null);
      setFocusAfter({ kind: "doc", id: doc.id });
    } catch (e) {
      return errorMessage(e, "Couldn't rename this document.");
    }
  };

  const moveDocs = async (ids: string[], folderId: string | null) => {
    if (ids.length === 0) return;
    setNotice(null);
    setWorking(ids.length === 1 ? ids[0] : null);
    try {
      if (ids.length === 1) await patchDocument(ids[0], { doc_folder_id: folderId }, "Couldn't move this document.");
      else await bulkDocuments({ action: "move", ids, doc_folder_id: folderId });
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

  /** Archive, restore or delete one document, then drop it from this list (ported from the old switcher). */
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
      // Leave an archived or deleted document for a new one. Archiving doesn't
      // move updated_at, so the editor's last edits still save as it unmounts;
      // a restored document stays open and keeps saving.
      if (doc.id === activeId && action !== "unarchive") leaveOpenDocument();
    } catch (e) {
      setNotice(errorMessage(e, `Couldn't ${action} this document.`));
      // A failed delete leaves its confirm open: focus back on its Delete button.
      // A failed archive or restore hands focus back to the row's ⋯ button.
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
      const moveIds = newFolder?.moveIds ?? [];
      setNewFolder(null);
      if (moveIds.length) await moveDocs(moveIds, folder.id);
      else reload();
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
      if (inside) setView(ROOT_VIEW);
      reload();
    } catch (e) {
      setNotice(errorMessage(e, "Couldn't delete the folder."));
      setFocusAfter({ kind: "confirm" });
    } finally {
      setWorking(null);
    }
  };

  // --- Bulk -------------------------------------------------------------------------

  const runBulk = async (action: BulkAction, folderId?: string | null) => {
    if (selection.length === 0) return;
    setBulkWorking(action);
    setNotice(null);
    try {
      const ids = [...selection];
      const result = await bulkDocuments(action === "move" ? { action, ids, doc_folder_id: folderId ?? null } : { action, ids });
      if (action === "move" && belongsInView({ doc_folder_id: folderId ?? null }, view, flat)) patchDocs(result.done, { doc_folder_id: folderId ?? null });
      else removeDocs(result.done);
      exitSelect();
      setFocusAfter({ kind: "select" });
      reload();
      if (result.missing.length) {
        const n = result.missing.length;
        setNotice(`${n} ${n === 1 ? "document wasn't" : "documents weren't"} found and ${n === 1 ? "was" : "were"} left alone. ${n === 1 ? "It" : "They"} may have been deleted.`);
      }
      if (activeId && result.done.includes(activeId) && (action === "archive" || action === "delete")) leaveOpenDocument();
    } catch (e) {
      setNotice(errorMessage(e, "Couldn't update those documents."));
      setFocusAfter({ kind: "select" });
    } finally {
      setBulkWorking(null);
    }
  };

  // --- Rendering --------------------------------------------------------------------

  const visibleIds = docs?.map((d) => d.id) ?? [];
  const emptyText = searchInput.trim()
    ? "No documents match."
    : archived
      ? "No archived documents."
      : view.kind === "folder"
        ? "This folder is empty."
        : folders.length
          ? "No documents outside folders."
          : "No documents yet. Start writing and this one is saved here.";

  const newFolderRow = newFolder && (
    <InlineNameInput
      label="New folder name"
      placeholder="Folder name"
      onSave={createFolderNamed}
      onCancel={() => setNewFolder(null)}
      className="px-4 py-2"
    />
  );

  const documentList = (
    <>
      {docs === null && !lib.error && (
        <p className="flex items-center gap-2 px-4 py-3 text-[15px] text-[var(--panel-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {docs && docs.length === 0 && <p className="px-4 py-3 text-[15px] text-[var(--panel-muted)]">{emptyText}</p>}
      {docs && docs.length > 0 && (
        <ul className="flex flex-col gap-0.5" aria-label={view.kind === "folder" ? `Documents in ${currentFolder?.name ?? "this folder"}` : "Documents"}>
          {docs.map((d) => {
            const isActive = d.id === activeId;
            const title = displayTitle(isActive && active ? active.title : d.title);
            const mode = row?.kind === "doc" && row.id === d.id ? row.mode : null;
            return (
              <DocumentRow
                key={d.id}
                doc={d}
                title={title}
                typeTitle={findType(catalog.types, d.type_key)?.title ?? ""}
                folderName={flat && d.doc_folder_id ? (folderById.get(d.doc_folder_id)?.name ?? null) : null}
                active={isActive}
                archivedView={archived}
                folders={folders}
                mode={mode}
                working={working === d.id}
                selecting={selecting}
                selected={selection.includes(d.id)}
                onToggleSelect={() => dispatchSelection({ type: "toggle", id: d.id })}
                onNavigate={afterNavigate}
                onRename={(handoff) => {
                  // The open document's title belongs to the editor (its autosave
                  // owns it); renaming it here would race that save.
                  if (isActive) handoff(focusEditorTitle);
                  else {
                    handoff();
                    setRow({ kind: "doc", id: d.id, mode: "rename" });
                  }
                }}
                onRenameSave={(t) => renameDoc(d, t)}
                onRenameCancel={() => {
                  setRow(null);
                  setFocusAfter({ kind: "doc-menu", id: d.id });
                }}
                onMove={(folderId) => void moveDocs([d.id], folderId)}
                onNewFolder={() => setNewFolder({ moveIds: [d.id] })}
                onArchiveToggle={() => void act(d, archived ? "unarchive" : "archive")}
                onAskDelete={() => setRow({ kind: "doc", id: d.id, mode: "confirm" })}
                onConfirmDelete={() => void act(d, "delete")}
                onCancelDelete={() => {
                  setRow(null);
                  setFocusAfter({ kind: "doc-menu", id: d.id });
                }}
              />
            );
          })}
        </ul>
      )}
    </>
  );

  const closedOrHidden = !open;

  return (
    <>
      {!wide && open && <button type="button" tabIndex={-1} aria-label="Close documents" onClick={() => onClose()} className="fixed inset-0 z-[45] cursor-default bg-[var(--scrim)]" />}
      <div
        className={
          wide
            ? `sticky top-0 h-dvh shrink-0 overflow-hidden ${animate ? "transition-[width,visibility] duration-200 ease-out motion-reduce:transition-none" : ""} ${open ? "w-[var(--docs-panel-w)]" : "invisible w-0"}`
            : "contents"
        }
      >
        <aside
          id="docs-panel"
          aria-labelledby="docs-panel-title"
          role={wide ? undefined : "dialog"}
          aria-modal={!wide && open ? true : undefined}
          aria-hidden={closedOrHidden || undefined}
          inert={closedOrHidden || undefined}
          className={`@container/panel flex flex-col bg-[var(--panel-bg)] text-[var(--panel-ink)] ${PANEL_W} ${
            wide
              ? "h-full"
              : `fixed inset-y-0 left-[56px] z-[46] h-dvh shadow-[8px_0_24px_-12px_rgba(0,0,0,0.25)] sm:left-[72px] ${
                  animate ? "transition-[translate,visibility] duration-200 ease-out motion-reduce:transition-none" : ""
                } ${open ? "translate-x-0" : "invisible -translate-x-full"}`
          }`}
        >
          <div className="px-4 pt-6 pb-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
              <h2 id="docs-panel-title" ref={headingRef} tabIndex={-1} className={`${SECTION_HEAD} mr-auto rounded-md outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--panel-head)]`}>
                <DocsIcon className="h-6 w-6" aria-hidden /> Documents
              </h2>
              <button
                ref={selectButtonRef}
                type="button"
                aria-pressed={selecting}
                onClick={() => (selecting ? exitSelect() : (setRow(null), setSelecting(true)))}
                className={BLUE_BUTTON}
              >
                <SelectIcon className="h-5 w-5" aria-hidden /> {selecting ? "Done" : "Select"}
              </button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={BLUE_BUTTON}>
                    <NewDocIcon className="h-5 w-5" aria-hidden /> New
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem onSelect={leaveOpenDocument}>
                    <FileText className="h-4 w-4" /> Blank document
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setGalleryOpen(true)}>
                    <TypesIcon className="h-4 w-4" /> From a type…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* As an overlay (a modal dialog) the panel needs its own way out:
                  phones have no Esc, and aria-modal hides the rail's toggle
                  from screen-reader swipe navigation. */}
              {!wide && (
                <button type="button" aria-label="Close documents" title="Close documents" onClick={() => onClose()} className={`flex min-h-11 min-w-11 items-center justify-center rounded-lg sm:min-h-9 sm:min-w-9 hover:bg-[var(--panel-hover)] ${FOCUS_RING}`}>
                  <X className="h-5 w-5" aria-hidden />
                </button>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--panel-hover)] px-2.5 focus-within:outline-2 focus-within:outline-[var(--panel-head)]">
                <Search className="h-4 w-4 shrink-0 text-[var(--panel-muted)]" aria-hidden />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc in a non-empty search clears it rather than closing the panel.
                    if (e.key === "Escape" && searchInput) {
                      e.preventDefault();
                      e.stopPropagation();
                      setSearchInput("");
                    }
                  }}
                  placeholder="Search documents"
                  aria-label="Search documents"
                  className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--panel-ink)] outline-none placeholder:text-[var(--panel-muted)]"
                />
              </div>
              <button
                type="button"
                aria-pressed={archived}
                onClick={() => setArchived((a) => !a)}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[14px] font-medium hover:bg-[var(--panel-hover)] aria-pressed:bg-[var(--panel-select)] aria-pressed:text-[var(--panel-ink)] ${FOCUS_RING}`}
              >
                <Archive className="h-4 w-4" aria-hidden /> Archived
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 sm:px-3">
            {(lib.error || notice) && (
              <p role="alert" className="mx-2 mb-2 rounded-lg bg-[var(--panel-badge-bg)] px-3 py-2 text-[14px] text-red-700 dark:text-red-400">
                {notice ?? lib.error}
              </p>
            )}

            {view.kind === "folder" && !flat ? (
              <section aria-labelledby="docs-panel-folder-title">
                <button
                  type="button"
                  onClick={() => setView(ROOT_VIEW)}
                  className={`mb-2 ml-2 flex items-center gap-1.5 rounded-md px-1 py-1 text-[15px] font-semibold text-[var(--action)] hover:underline ${FOCUS_RING}`}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden /> All documents
                </button>
                {currentFolder && row?.kind === "folder" && row.id === currentFolder.id && row.mode === "confirm" ? (
                  <div className="mb-2">
                    <FolderDeleteConfirm
                      folder={currentFolder}
                      working={working === currentFolder.id}
                      onConfirm={() => void deleteFolderNow(currentFolder)}
                      onCancel={() => {
                        setRow(null);
                        setFocusAfter({ kind: "folder-menu", id: currentFolder.id });
                      }}
                    />
                  </div>
                ) : currentFolder && row?.kind === "folder" && row.id === currentFolder.id && row.mode === "rename" ? (
                  <InlineNameInput
                    initial={currentFolder.name}
                    label={`Rename folder ${currentFolder.name}`}
                    onSave={(name) => renameFolderTo(currentFolder, name)}
                    onCancel={() => {
                      setRow(null);
                      setFocusAfter({ kind: "folder-menu", id: currentFolder.id });
                    }}
                    className="mb-2 px-4 py-1"
                  />
                ) : (
                  <div className="mb-2 flex items-center gap-2 pl-4 pr-[calc(0.25rem+2px)]">
                    <h3 id="docs-panel-folder-title" className="flex min-w-0 flex-1 items-center gap-2 text-[17px] font-semibold text-[var(--panel-head)]">
                      <DocFolderIcon className="h-5 w-5 shrink-0" aria-hidden />
                      <span className="truncate">{currentFolder?.name || view.name || "Folder"}</span>
                    </h3>
                    {currentFolder && (
                      <FolderMenu
                        folder={currentFolder}
                        working={working === currentFolder.id}
                        onRename={() => setRow({ kind: "folder", id: currentFolder.id, mode: "rename" })}
                        onAskDelete={() => setRow({ kind: "folder", id: currentFolder.id, mode: "confirm" })}
                      />
                    )}
                  </div>
                )}
                {newFolderRow}
                {documentList}
              </section>
            ) : (
              <>
                {flat && newFolderRow}
                {documentList}
                {!flat && (
                  <section aria-labelledby="docs-panel-folders-title" className="mt-8">
                    <div className="mb-2 flex items-center gap-2 px-2 sm:px-3">
                      <h3 id="docs-panel-folders-title" className={`${SECTION_HEAD} mr-auto`}>
                        <DocFolderIcon className="h-6 w-6" aria-hidden /> Folders
                      </h3>
                      <button type="button" onClick={() => setNewFolder({ moveIds: [] })} className={`${BLUE_BUTTON} text-[15px]!`}>
                        <NewDocFolderIcon className="h-5 w-5" aria-hidden /> New folder
                      </button>
                    </div>
                    {newFolderRow}
                    {loadedFolders && folders.length === 0 && !newFolder && (
                      <p className="px-4 py-2 text-[15px] text-[var(--panel-muted)]">No folders yet. Folders keep related documents together.</p>
                    )}
                    {folders.length > 0 && (
                      <ul className="flex flex-col gap-0.5" aria-label="Folders">
                        {folders.map((f) => (
                          <FolderRow
                            key={f.id}
                            folder={f}
                            mode={row?.kind === "folder" && row.id === f.id ? row.mode : null}
                            working={working === f.id}
                            onOpen={() => {
                              exitSelect();
                              setView({ kind: "folder", id: f.id, name: f.name });
                            }}
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
                      </ul>
                    )}
                  </section>
                )}
              </>
            )}
          </div>

          {selecting && (
            <DocsBulkBar
              count={selection.length}
              allSelected={everySelected(selection, visibleIds)}
              archivedView={archived}
              folders={folders}
              working={bulkWorking}
              onSelectAll={() => dispatchSelection({ type: "all", ids: visibleIds })}
              onSelectNone={() => dispatchSelection({ type: "none" })}
              onAction={runBulk}
            />
          )}
        </aside>
      </div>

      <TypeGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        types={catalog.types}
        loading={catalog.loading}
        error={catalog.error}
        title="New document from a type"
        onChoose={async (t) => {
          try {
            const id = await createDocumentOfType(t.key);
            // Started from inside a folder: file it there. A failed move still
            // opens the new document (it just lands at the top level).
            if (view.kind === "folder" && !flat) await patchDocument(id, { doc_folder_id: view.id }).catch(() => undefined);
            setGalleryOpen(false);
            router.push(`/d/${id}`);
            afterNavigate();
          } catch (e) {
            return errorMessage(e, "Couldn't create the document.");
          }
        }}
      />
    </>
  );
}
