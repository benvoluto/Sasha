"use client";

// The folder tiles under the overview's cards (redesign3-spec.md §2 Folders,
// docs/documents.png): each folder as a pale orange folder shape with its name
// and document count, plus "New folder" (a dashed tile that turns into a name
// field) and "Archived". A folder tile opens the folder in place, takes a card
// dropped on it, and has a ⋯ menu (rename, delete with an inline confirm).

import { useState } from "react";
import { Archive, Loader2, MoreHorizontalIcon, NewDocFolderIcon, Pencil, Trash2 } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { DocumentFolder } from "@/lib/documents/folders-contract";
import { ConfirmRow, FOCUS_RING, InlineNameInput, MENU_BUTTON, useMenuFocusHandoff } from "./inline-edit";
import { DOC_DRAG_TYPE, documentCountLabel } from "./overview-model";

export type FolderMode = "rename" | "confirm" | null;

/** The body under the folder's tab: the tab is 22px tall and joins the body's top left corner. */
const BODY = "relative mt-[22px] flex min-h-[130px] flex-col rounded-2xl p-4 sm:h-[154px] sm:p-5";

function FolderTab({ className = "bg-[var(--folder-bg)]" }: { className?: string }) {
  return <span aria-hidden className={`absolute left-0 top-0 h-[23px] w-[40%] rounded-t-xl ${className}`} />;
}

/** The ⋯ menu for a folder (its tile, and the heading inside it). */
export function FolderMenu({ folder, working, onRename, onAskDelete, className = "" }: { folder: DocumentFolder; working: boolean; onRename: () => void; onAskDelete: () => void; className?: string }) {
  const menu = useMenuFocusHandoff();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-folder-menu={folder.id} disabled={working} aria-label={`Actions for folder ${folder.name}`} className={`${MENU_BUTTON} text-[var(--folder-ink)] hover:bg-[var(--page-bg)] data-[state=open]:bg-[var(--page-bg)] ${className}`}>
          {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontalIcon className="h-5 w-5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <DropdownMenuItem
          onSelect={() => {
            menu.handoff();
            onRename();
          }}
        >
          <Pencil className="h-4 w-4" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            menu.handoff();
            onAskDelete();
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FolderDeleteConfirm({ folder, working, onConfirm, onCancel, className }: { folder: DocumentFolder; working: boolean; onConfirm: () => void; onCancel: () => void; className?: string }) {
  return (
    <ConfirmRow label={`Delete folder ${folder.name}`} working={working} onConfirm={onConfirm} onCancel={onCancel} className={className}>
      Delete folder “{folder.name}”? Its documents move to the top level.
    </ConfirmRow>
  );
}

export function FolderTile({
  folder,
  mode,
  working,
  onOpen,
  onDropDocument,
  onRename,
  onRenameSave,
  onRenameCancel,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  folder: DocumentFolder;
  mode: FolderMode;
  working: boolean;
  onOpen: () => void;
  /** A card was dropped on the tile. */
  onDropDocument: (documentId: string) => void;
  onRename: () => void;
  onRenameSave: (name: string) => Promise<string | void>;
  onRenameCancel: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [dropping, setDropping] = useState(false);
  const isDocDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(DOC_DRAG_TYPE);

  return (
    <li
      className="group relative"
      data-folder-tile={folder.id}
      onDragOver={(e) => {
        if (!isDocDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DOC_DRAG_TYPE);
        setDropping(false);
        if (!id) return;
        e.preventDefault();
        onDropDocument(id);
      }}
    >
      <FolderTab />
      <div className={`${BODY} rounded-tl-none bg-[var(--folder-bg)] ${dropping ? "outline-solid outline-2 outline-offset-2 outline-[var(--folder-ink)]" : ""}`}>
        {mode === "confirm" ? (
          <FolderDeleteConfirm folder={folder} working={working} onConfirm={onConfirmDelete} onCancel={onCancelDelete} className="my-auto" />
        ) : mode === "rename" ? (
          <InlineNameInput initial={folder.name} label={`Rename folder ${folder.name}`} onSave={onRenameSave} onCancel={onRenameCancel} tone="folder" />
        ) : (
          <>
            <button
              type="button"
              data-folder-open={folder.id}
              onClick={onOpen}
              aria-label={`${folder.name}, ${documentCountLabel(folder.document_count)}`}
              className="mr-9 rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--folder-ink)]"
            >
              <span className="line-clamp-2 break-words text-[17px] leading-snug text-[var(--folder-ink)]">{folder.name}</span>
            </button>
            <span aria-hidden className="mt-auto grid h-8 min-w-8 place-items-center self-start rounded-lg bg-[var(--folder-badge-bg)] px-1.5 text-[15px] text-[var(--folder-badge-ink)]">
              {folder.document_count}
            </span>
            <div className="absolute right-1.5 top-1.5 z-10">
              <FolderMenu folder={folder} working={working} onRename={onRename} onAskDelete={onAskDelete} />
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/** "New folder": a dashed tile that becomes a name field; Enter creates the folder. */
export function NewFolderTile({ editing, onStart, onSave, onCancel }: { editing: boolean; onStart: () => void; onSave: (name: string) => Promise<string | void>; onCancel: () => void }) {
  const tile = `${BODY} w-full border-2 border-dashed border-[var(--folder-ink)] text-[var(--folder-ink)]`;
  return (
    <li className="relative">
      {editing ? (
        <div className={tile}>
          <InlineNameInput label="New folder name" placeholder="Folder name" onSave={onSave} onCancel={onCancel} tone="folder" />
        </div>
      ) : (
        <button type="button" data-new-folder onClick={onStart} className={`${tile} items-start justify-between text-left hover:bg-[var(--folder-bg)] ${FOCUS_RING}`}>
          <NewDocFolderIcon className="h-7 w-7" aria-hidden />
          <span className="text-[17px]">New folder</span>
        </button>
      )}
    </li>
  );
}

/** "Archived": opens the archived view. */
export function ArchivedTile({ onOpen }: { onOpen: () => void }) {
  return (
    <li className="relative">
      <button
        type="button"
        data-archived-tile
        onClick={onOpen}
        className={`${BODY} w-full items-start justify-between border border-[var(--card-line)] bg-[var(--card-bg)] text-left text-[var(--card-title)] hover:border-[var(--card-sub)] ${FOCUS_RING}`}
      >
        <Archive className="h-7 w-7 text-[var(--card-sub)]" aria-hidden />
        <span className="text-[17px]">Archived</span>
      </button>
    </li>
  );
}
