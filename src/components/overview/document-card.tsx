"use client";

// One document on the overview's grid (redesign3-spec.md §2, docs/documents.png):
// the type's icon, the title ("Untitled" in grey when blank) and the first line
// of the body. The title is a stretched link, so the whole card opens the
// document while its ⋯ menu stays a separate control. In Select mode the card
// shows a checkbox and clicking it toggles that instead. Cards can be dragged
// onto a folder tile (the keyboard and touch alternatives are "Move to…" and
// the Select bar). The overview owns the state and the requests; this renders
// and reports.

import Link from "next/link";
import { Archive, ArchiveRestore, Loader2, MoreHorizontalIcon, MoveToFolderIcon, Pencil, Trash2 } from "@/components/icons";
import { TypeIcon } from "@/components/type-icon";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DocumentTypeSummary } from "@/catalog/schema";
import { cardSubtitle } from "@/lib/documents/card-text";
import type { DocumentFolder, DocumentListItem } from "@/lib/documents/folders-contract";
import { ConfirmRow, FOCUS_RING, InlineNameInput, MENU_BUTTON, MoveToFolderItems, useMenuFocusHandoff } from "./inline-edit";
import { displayTitle, DOC_DRAG_TYPE } from "./overview-model";

export type CardMode = "rename" | "confirm" | null;

export function DocumentCard({
  doc,
  type,
  archivedView,
  folders,
  mode,
  working,
  selecting,
  selected,
  onToggleSelect,
  onRename,
  onRenameSave,
  onRenameCancel,
  onMove,
  onArchiveToggle,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  doc: DocumentListItem;
  type: DocumentTypeSummary | null;
  archivedView: boolean;
  folders: DocumentFolder[];
  mode: CardMode;
  working: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onRename: () => void;
  onRenameSave: (title: string) => Promise<string | void>;
  onRenameCancel: () => void;
  onMove: (folderId: string | null) => void;
  onArchiveToggle: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const menu = useMenuFocusHandoff();
  const title = displayTitle(doc.title);
  const blank = !doc.title.trim();
  const subtitle = cardSubtitle(doc.title, doc.excerpt, doc.lead);
  const checkboxId = `doc-select-${doc.id}`;

  const shell = `group relative flex min-h-[150px] flex-col rounded-2xl border border-[var(--card-line)] bg-[var(--card-bg)] p-4 sm:h-[188px] sm:p-5 ${
    selected ? "ring-2 ring-[var(--action)]" : ""
  }`;

  if (mode === "confirm") {
    return (
      <li className={shell}>
        <ConfirmRow label={`Delete ${title}`} working={working} onConfirm={onConfirmDelete} onCancel={onCancelDelete} className="my-auto">
          Delete “{title}”?
        </ConfirmRow>
      </li>
    );
  }

  const titleText = (
    <span className={`line-clamp-2 break-words text-[17px] font-medium leading-snug sm:text-[19px] ${blank ? "text-[var(--card-untitled)]" : "text-[var(--card-title)]"}`}>{title}</span>
  );
  // The stretched target: its ::after covers the card, and carries the focus ring.
  const stretched = "mt-3 block rounded-sm outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--action)]";

  return (
    <li
      className={shell}
      data-card={doc.id}
      draggable={!selecting && mode === null}
      onDragStart={(e) => {
        e.dataTransfer.setData(DOC_DRAG_TYPE, doc.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="flex items-start gap-2">
        {selecting && (
          <Checkbox
            id={checkboxId}
            checked={selected}
            onCheckedChange={onToggleSelect}
            aria-label={`Select ${title}`}
            className={`relative z-10 size-6 rounded-md border-[var(--card-sub)] bg-[var(--editor-bg)] data-[state=checked]:border-[var(--action)] data-[state=checked]:bg-[var(--action)] data-[state=checked]:text-white sm:size-5 ${FOCUS_RING}`}
          />
        )}
        <TypeIcon icon={type?.icon} color={type?.color} className="h-8 w-8" />
      </div>
      {mode === "rename" ? (
        <InlineNameInput initial={doc.title} label={`Rename ${title}`} placeholder="Untitled" onSave={onRenameSave} onCancel={onRenameCancel} className="mt-3" />
      ) : selecting ? (
        // Clicking anywhere on the card toggles the checkbox (the label's target).
        <label htmlFor={checkboxId} className={`${stretched} cursor-pointer`}>
          {titleText}
        </label>
      ) : (
        <Link href={`/d/${doc.id}`} data-doc-link={doc.id} draggable={false} className={stretched}>
          {titleText}
        </Link>
      )}
      {subtitle && <p className="mt-1.5 line-clamp-2 break-words text-[14px] text-[var(--card-sub)]">{subtitle}</p>}

      {mode === null && (
        // Kept (disabled) in Select mode, so the card's controls don't shift.
        <div className="absolute right-1.5 top-1.5 z-10">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" data-doc-menu={doc.id} disabled={working || selecting} aria-label={`Actions for ${title}`} className={`${MENU_BUTTON} text-[var(--card-sub)] hover:bg-[var(--page-bg)] data-[state=open]:bg-[var(--page-bg)] ${selecting ? "opacity-0!" : ""}`}>
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontalIcon className="h-5 w-5" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48" onCloseAutoFocus={menu.onCloseAutoFocus}>
              {!archivedView && (
                <>
                  <DropdownMenuItem
                    onSelect={() => {
                      menu.handoff();
                      onRename();
                    }}
                  >
                    <Pencil className="h-4 w-4" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2">
                      <MoveToFolderIcon className="h-4 w-4" /> Move to…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-[60vh] min-w-48 overflow-y-auto">
                      <MoveToFolderItems folders={folders} current={doc.doc_folder_id} onMove={onMove} />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
              <DropdownMenuItem onSelect={onArchiveToggle}>
                {archivedView ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />} {archivedView ? "Restore" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
        </div>
      )}
    </li>
  );
}
