"use client";

// The rows of the documents panel: documents (title · type · Active · date ·
// ⋯) and folders (name · count · date · ⋯), plus the small inline pieces they
// share — the rename/new-folder input, the red delete confirm and the "Move to
// folder" menu items. The panel (docs-panel.tsx) owns the state and the
// requests; these only render and report.
//
// Layout: the panel's list is a `@container/panel`, so rows drop the type
// column (it moves under the title) when the panel is phone-narrow instead of
// squeezing the title to nothing.

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Check, Loader2, MoreHorizontalIcon, MoveToFolderIcon, NewDocFolderIcon, Pencil, Trash2 } from "@/components/icons";
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
import type { DocumentFolder, DocumentListItem } from "@/lib/documents/folders-contract";
import { documentCountLabel, formatPanelDate } from "./docs-panel-model";

export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--panel-head)]";

/** Title · (type) · badge · date. Narrow panels hide the type column. */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto_4.75rem] items-center gap-x-2 @[24rem]/panel:grid-cols-[minmax(0,1fr)_5rem_3.5rem_4.75rem] @[34rem]/panel:grid-cols-[minmax(0,1fr)_6.5rem_4.5rem_5.5rem] @[34rem]/panel:gap-x-3";
/** Row padding: roomier once the panel is wide (the mockup's rows). */
const ROW_PAD = "py-3 pl-4 pr-1 @[34rem]/panel:py-4 @[34rem]/panel:pl-7";
const ROW_SHELL = "group grid items-center rounded-xl border-2 text-[15px] text-[var(--panel-ink)] hover:bg-[var(--panel-hover)] @[34rem]/panel:text-[16px]";
const MENU_BUTTON = `grid h-8 w-8 place-items-center rounded-lg text-[var(--panel-ink)] hover:bg-[var(--panel-badge-bg)] data-[state=open]:bg-[var(--panel-badge-bg)] disabled:opacity-40 ${FOCUS_RING}`;

/**
 * Menu items that move focus somewhere else (an inline input, a confirm
 * button, the editor's title) must stop Radix from returning focus to the ⋯
 * trigger as the menu closes. handoff(fn) runs fn in place of that return.
 */
export function useMenuFocusHandoff() {
  const pending = useRef<(() => void) | null>(null);
  return {
    handoff: (fn: () => void = () => {}) => {
      pending.current = fn;
    },
    onCloseAutoFocus: (e: Event) => {
      const fn = pending.current;
      if (!fn) return;
      pending.current = null;
      e.preventDefault();
      fn();
    },
  };
}

// --- Inline pieces -----------------------------------------------------------

/**
 * An inline name field (rename, new folder). Enter saves; Esc, or leaving it
 * unchanged, cancels. It handles its own Esc (and stops it) so the panel's Esc
 * doesn't also close the panel.
 */
export function InlineNameInput({
  initial = "",
  label,
  placeholder,
  onSave,
  onCancel,
  className = "",
}: {
  initial?: string;
  label: string;
  placeholder?: string;
  /** Resolves to an error message to show (the field stays open), or nothing when saved. */
  onSave: (name: string) => Promise<string | void>;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = async () => {
    const name = value.trim();
    if (!name || name === initial.trim()) return onCancel();
    setSaving(true);
    const message = await onSave(name);
    setSaving(false);
    if (message) {
      setError(message);
      ref.current?.focus();
    }
  };

  return (
    <div data-inline-edit className={className}>
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          value={value}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${label}-error` : undefined}
          placeholder={placeholder}
          disabled={saving}
          maxLength={300}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          onBlur={() => {
            if (!saving && !error && value.trim() === initial.trim()) onCancel();
          }}
          className={`min-w-0 flex-1 rounded-lg border border-[var(--panel-select)] bg-[var(--panel-badge-bg)] px-2.5 py-1.5 text-[15px] text-[var(--panel-ink)] outline-none focus:border-[var(--panel-head)] ${FOCUS_RING}`}
        />
        {saving && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--panel-muted)]" />}
      </div>
      {error && (
        <p id={`${label}-error`} role="alert" className="mt-1 text-[13px] text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** The red "delete this?" row. Delete gets focus; Esc cancels. */
export function ConfirmRow({ label, children, working, onConfirm, onCancel }: { label: string; children: ReactNode; working: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div
      role="group"
      aria-label={label}
      data-inline-edit
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-wrap items-center gap-2 rounded-xl bg-red-50 px-4 py-2.5 text-[14px] text-red-950 dark:bg-red-950/40 dark:text-red-100"
    >
      <p className="min-w-0 flex-1">{children}</p>
      <button
        type="button"
        autoFocus
        data-confirm-delete
        disabled={working}
        onClick={onConfirm}
        className="flex shrink-0 items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-50"
      >
        {working && <Loader2 className="h-3 w-3 animate-spin" />} Delete
      </button>
      <button type="button" onClick={onCancel} className={`shrink-0 rounded-md px-2 py-1 text-[13px] hover:underline ${FOCUS_RING}`}>
        Cancel
      </button>
    </div>
  );
}

/** "No folder", each folder (the current one checked and disabled), then "New folder…". */
export function MoveToFolderItems({
  folders,
  current,
  onMove,
  onNewFolder,
}: {
  folders: DocumentFolder[];
  /** The documents' current folder (null = top level); undefined when mixed or unknown. */
  current: string | null | undefined;
  onMove: (folderId: string | null) => void;
  onNewFolder?: () => void;
}) {
  const item = (id: string | null, label: string) => (
    <DropdownMenuItem key={id ?? "root"} disabled={current === id} onSelect={() => onMove(id)}>
      <span className="grid w-4 place-items-center">{current === id && <Check className="h-3.5 w-3.5" />}</span>
      <span className="truncate">{label}</span>
    </DropdownMenuItem>
  );
  return (
    <>
      {item(null, "No folder")}
      {folders.map((f) => item(f.id, f.name))}
      {onNewFolder && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onNewFolder}>
            <NewDocFolderIcon className="h-4 w-4" /> New folder…
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

// --- Document row ------------------------------------------------------------

export type RowMode = "rename" | "confirm" | null;

export function DocumentRow({
  doc,
  title,
  typeTitle,
  folderName,
  active,
  archivedView,
  folders,
  mode,
  working,
  selecting,
  selected,
  onToggleSelect,
  onNavigate,
  onRename,
  onRenameSave,
  onRenameCancel,
  onMove,
  onNewFolder,
  onArchiveToggle,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  doc: DocumentListItem;
  /** The title shown (the open document's comes live from the editor). */
  title: string;
  typeTitle: string;
  /** Shown in flat lists (search, archive) for a filed document. */
  folderName: string | null;
  active: boolean;
  archivedView: boolean;
  folders: DocumentFolder[];
  mode: RowMode;
  working: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onNavigate: () => void;
  /** Rename chosen; `handoff` lets the panel take focus (the inline field, or the editor's title). */
  onRename: (handoff: (fn?: () => void) => void) => void;
  onRenameSave: (title: string) => Promise<string | void>;
  onRenameCancel: () => void;
  onMove: (folderId: string | null) => void;
  onNewFolder: () => void;
  onArchiveToggle: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const menu = useMenuFocusHandoff();

  if (mode === "confirm") {
    return (
      <li>
        <ConfirmRow label={`Delete ${title}`} working={working} onConfirm={onConfirmDelete} onCancel={onCancelDelete}>
          Delete <span className="font-semibold">{title}</span> permanently?
        </ConfirmRow>
      </li>
    );
  }

  const secondary = [typeTitle, folderName ? `in ${folderName}` : ""].filter(Boolean).join(" · ");
  const cells = (
    <>
      <span className="min-w-0">
        {mode === "rename" ? null : <span className="block truncate font-medium">{title}</span>}
        {secondary && <span className="block truncate text-[13px] text-[var(--panel-muted)] @[24rem]/panel:hidden">{secondary}</span>}
        {folderName && <span className="hidden truncate text-[13px] text-[var(--panel-muted)] @[24rem]/panel:block">in {folderName}</span>}
      </span>
      <span className="hidden truncate @[24rem]/panel:block" title={typeTitle || undefined}>
        {typeTitle}
      </span>
      <span>
        {active && <span className="rounded-md bg-[var(--panel-badge-bg)] px-2 py-0.5 text-[12px] font-medium text-[var(--panel-head)]">Active</span>}
      </span>
      <span className="text-right tabular-nums">{formatPanelDate(doc.updated_at)}</span>
    </>
  );

  const checkboxId = `doc-select-${doc.id}`;
  return (
    <li
      className={`${ROW_SHELL} ${selecting ? "grid-cols-[auto_minmax(0,1fr)_2rem]" : "grid-cols-[minmax(0,1fr)_2rem]"} ${
        active ? "border-[var(--panel-select)]" : "border-transparent"
      } ${selected ? "bg-[var(--panel-hover)]" : ""}`}
    >
      {selecting && (
        <Checkbox
          id={checkboxId}
          checked={selected}
          onCheckedChange={onToggleSelect}
          className={`ml-3 size-5 rounded-md border-[var(--panel-head)] bg-[var(--panel-badge-bg)] data-[state=checked]:border-[var(--action)] data-[state=checked]:bg-[var(--action)] data-[state=checked]:text-white ${FOCUS_RING}`}
        />
      )}
      {mode === "rename" ? (
        <div className={`${ROW_GRID} py-2 pl-3 pr-1`}>
          <InlineNameInput initial={doc.title} label={`Rename ${title}`} placeholder="Untitled document" onSave={onRenameSave} onCancel={onRenameCancel} />
          <span className="hidden @[24rem]/panel:block" />
          <span />
          <span className="text-right tabular-nums">{formatPanelDate(doc.updated_at)}</span>
        </div>
      ) : selecting ? (
        <label htmlFor={checkboxId} className={`${ROW_GRID} cursor-pointer py-3 pl-3 pr-1`}>
          {cells}
        </label>
      ) : (
        <Link href={`/d/${doc.id}`} data-doc-link={doc.id} onClick={onNavigate} aria-current={active ? "page" : undefined} className={`${ROW_GRID} rounded-xl ${ROW_PAD} ${FOCUS_RING}`}>
          {cells}
        </Link>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" data-doc-menu={doc.id} disabled={working || selecting} aria-label={`Actions for ${title}`} className={`${MENU_BUTTON} ${selecting ? "invisible" : ""}`}>
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontalIcon className="h-5 w-5" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48" onCloseAutoFocus={menu.onCloseAutoFocus}>
          <DropdownMenuItem onSelect={() => onRename(menu.handoff)}>
            <Pencil className="h-4 w-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <MoveToFolderIcon className="h-4 w-4" /> Move to folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[60vh] min-w-48 overflow-y-auto">
              <MoveToFolderItems
                folders={folders}
                current={doc.doc_folder_id}
                onMove={onMove}
                onNewFolder={() => {
                  menu.handoff();
                  onNewFolder();
                }}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
            <Trash2 className="h-4 w-4" /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

// --- Folder rows -------------------------------------------------------------

/** The ⋯ menu for a folder (its row, and the heading inside it). */
export function FolderMenu({ folder, working, onRename, onAskDelete, className = "" }: { folder: DocumentFolder; working: boolean; onRename: () => void; onAskDelete: () => void; className?: string }) {
  const menu = useMenuFocusHandoff();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-folder-menu={folder.id} disabled={working} aria-label={`Actions for folder ${folder.name}`} className={`${MENU_BUTTON} ${className}`}>
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
          <Trash2 className="h-4 w-4" /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FolderDeleteConfirm({ folder, working, onConfirm, onCancel }: { folder: DocumentFolder; working: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmRow label={`Delete folder ${folder.name}`} working={working} onConfirm={onConfirm} onCancel={onCancel}>
      Delete <span className="font-semibold">{folder.name}</span>? Its documents move to the top level.
    </ConfirmRow>
  );
}

export function FolderRow({
  folder,
  mode,
  working,
  onOpen,
  onRename,
  onRenameSave,
  onRenameCancel,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  folder: DocumentFolder;
  mode: RowMode;
  working: boolean;
  onOpen: () => void;
  onRename: () => void;
  onRenameSave: (name: string) => Promise<string | void>;
  onRenameCancel: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  if (mode === "confirm") {
    return (
      <li>
        <FolderDeleteConfirm folder={folder} working={working} onConfirm={onConfirmDelete} onCancel={onCancelDelete} />
      </li>
    );
  }
  const count = documentCountLabel(folder.document_count);
  return (
    <li className={`${ROW_SHELL} grid-cols-[minmax(0,1fr)_2rem] border-transparent`}>
      {mode === "rename" ? (
        <div className={`${ROW_GRID} py-2 pl-3 pr-1`}>
          <InlineNameInput initial={folder.name} label={`Rename folder ${folder.name}`} onSave={onRenameSave} onCancel={onRenameCancel} />
          <span className="hidden @[24rem]/panel:block" />
          <span />
          <span className="text-right tabular-nums">{formatPanelDate(folder.updated_at)}</span>
        </div>
      ) : (
        <button type="button" data-folder-open={folder.id} onClick={onOpen} aria-label={`${folder.name}, ${count}. Open folder`} className={`${ROW_GRID} rounded-xl ${ROW_PAD} text-left ${FOCUS_RING}`}>
          <span className="min-w-0">
            <span className="block truncate font-medium">{folder.name}</span>
            <span className="block text-[13px] text-[var(--panel-muted)] @[24rem]/panel:hidden">{count}</span>
          </span>
          <span className="hidden truncate @[24rem]/panel:col-span-2 @[24rem]/panel:block">{count}</span>
          <span className="@[24rem]/panel:hidden" />
          <span className="text-right tabular-nums">{formatPanelDate(folder.updated_at)}</span>
        </button>
      )}
      <FolderMenu folder={folder} working={working} onRename={onRename} onAskDelete={onAskDelete} />
    </li>
  );
}
