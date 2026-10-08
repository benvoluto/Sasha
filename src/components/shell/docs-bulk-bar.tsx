"use client";

// The bar pinned to the bottom of the documents panel in Select mode: how many
// documents are picked, select all/none, and the bulk actions (move, archive
// or restore, delete with an inline confirm). The panel runs the request.

import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Loader2, MoveToFolderIcon, Trash2 } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { BulkAction, DocumentFolder } from "@/lib/documents/folders-contract";
import { ConfirmRow, FOCUS_RING, MoveToFolderItems } from "./docs-panel-rows";

const ACTION = `flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[14px] font-semibold text-[var(--action)] hover:bg-[var(--action-soft)] disabled:opacity-40 ${FOCUS_RING}`;

export function DocsBulkBar({
  count,
  allSelected,
  archivedView,
  folders,
  working,
  onSelectAll,
  onSelectNone,
  onAction,
}: {
  count: number;
  allSelected: boolean;
  archivedView: boolean;
  folders: DocumentFolder[];
  /** The bulk action running, if any. */
  working: BulkAction | null;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onAction: (action: BulkAction, folderId?: string | null) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  /** Set when the confirm is cancelled: focus returns to the Delete button that opened it. */
  const [refocusDelete, setRefocusDelete] = useState(false);
  useEffect(() => {
    if (!refocusDelete) return;
    setRefocusDelete(false);
    deleteRef.current?.focus();
  }, [refocusDelete]);
  const none = count === 0;
  const busy = working !== null;

  return (
    <div role="toolbar" aria-label="Selected documents" className="sticky bottom-0 z-10 border-t border-[var(--panel-select)] bg-[var(--panel-bg)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
      {confirming ? (
        <ConfirmRow
          label="Delete selected documents"
          working={working === "delete"}
          onConfirm={() => void onAction("delete").then(() => setConfirming(false))}
          onCancel={() => {
            setConfirming(false);
            setRefocusDelete(true);
          }}
        >
          Delete {count} {count === 1 ? "document" : "documents"} permanently?
        </ConfirmRow>
      ) : (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
          <span className="mr-auto pl-1 text-[14px] font-medium text-[var(--panel-ink)]" aria-live="polite">
            {count} selected
          </span>
          <button type="button" onClick={allSelected ? onSelectNone : onSelectAll} className={ACTION}>
            {allSelected ? "Select none" : "Select all"}
          </button>
          {!archivedView && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" disabled={none || busy} className={ACTION}>
                  {working === "move" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoveToFolderIcon className="h-4 w-4" />} Move to…
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="max-h-[50vh] min-w-48 overflow-y-auto">
                <MoveToFolderItems folders={folders} current={undefined} onMove={(id) => void onAction("move", id)} />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button type="button" disabled={none || busy} onClick={() => void onAction(archivedView ? "restore" : "archive")} className={ACTION}>
            {working === "archive" || working === "restore" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : archivedView ? (
              <ArchiveRestore className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
            {archivedView ? "Restore" : "Archive"}
          </button>
          <button ref={deleteRef} type="button" disabled={none || busy} onClick={() => setConfirming(true)} className={`${ACTION} text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40`}>
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
