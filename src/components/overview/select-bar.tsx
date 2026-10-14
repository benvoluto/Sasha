"use client";

// The bar pinned to the bottom of the overview in Select mode
// (redesign3-spec.md §2 Select mode): how many documents are picked, select
// all/none, and the bulk actions (move, archive or restore, delete with an
// inline confirm), then Done. It starts past Sasha the dog on wider screens
// and runs full width on a phone. The overview runs the requests.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Archive, ArchiveRestore, Loader2, MoveToFolderIcon, Trash2 } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DOG_WIDTH } from "@/components/shell/dog";
import type { BulkAction, DocumentFolder } from "@/lib/documents/folders-contract";
import { ConfirmRow, FOCUS_RING, MoveToFolderItems } from "./inline-edit";
import { bulkDeleteQuestion } from "./overview-model";

const ACTION = `flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[15px] font-semibold text-[var(--action)] hover:bg-[var(--action-soft)] data-[state=open]:bg-[var(--action-soft)] disabled:opacity-40 sm:min-h-9 ${FOCUS_RING}`;

export function SelectBar({
  count,
  allSelected,
  archivedView,
  folders,
  working,
  onSelectAll,
  onSelectNone,
  onAction,
  onDone,
}: {
  count: number;
  allSelected: boolean;
  archivedView: boolean;
  folders: DocumentFolder[];
  /** The bulk action running, if any. */
  working: BulkAction | null;
  onSelectAll: () => void;
  onSelectNone: () => void;
  /** Resolves true when the request went through. */
  onAction: (action: BulkAction, folderId?: string | null) => Promise<boolean>;
  onDone: () => void;
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
    <div
      role="toolbar"
      aria-label="Selected documents"
      style={{ "--dog-w": `${DOG_WIDTH}px` } as CSSProperties}
      className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:left-[var(--dog-w)] sm:right-6 sm:px-0"
    >
      <div className="mx-auto max-w-4xl rounded-2xl border border-[var(--card-line)] bg-[var(--card-bg)] px-3 py-2 text-[var(--card-title)] shadow-[0_8px_30px_rgba(40,28,8,0.18)] sm:rounded-full sm:px-4">
        {confirming ? (
          <ConfirmRow
            label="Delete selected documents"
            working={working === "delete"}
            onConfirm={() => void onAction("delete").then((ok) => ok && setConfirming(false))}
            onCancel={() => {
              setConfirming(false);
              setRefocusDelete(true);
            }}
          >
            {bulkDeleteQuestion(count)}
          </ConfirmRow>
        ) : (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <span role="status" className="mr-auto px-1 text-[15px] font-medium">
              {count} selected
            </span>
            <button type="button" onClick={allSelected ? onSelectNone : onSelectAll} className={ACTION}>
              {allSelected ? "Select none" : "Select all"}
            </button>
            {!archivedView && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" disabled={none || busy} className={ACTION}>
                    {working === "move" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoveToFolderIcon className="h-4 w-4" aria-hidden />} Move to folder…
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
                <ArchiveRestore className="h-4 w-4" aria-hidden />
              ) : (
                <Archive className="h-4 w-4" aria-hidden />
              )}
              {archivedView ? "Restore" : "Archive"}
            </button>
            <button ref={deleteRef} type="button" disabled={none || busy} onClick={() => setConfirming(true)} className={`${ACTION} text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40`}>
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
            <button type="button" onClick={onDone} className={`${ACTION} bg-[var(--action-soft)]`}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
