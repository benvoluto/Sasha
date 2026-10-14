"use client";

// Small inline pieces the overview's cards, folder tiles and Select bar share:
// the rename / new-folder field, the red "delete this?" confirm, the "Move to"
// menu items, and the hand-off that stops a menu from pulling focus back to
// its ⋯ button when an item moves focus somewhere else. Ported from the old
// documents panel's rows.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "@/components/icons";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { DocumentFolder } from "@/lib/documents/folders-contract";

export const FOCUS_RING = "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]";

/** The ⋯ button on a card or folder tile: always shown on touch screens, else on hover or focus. */
export const MENU_BUTTON = `grid h-11 w-11 place-items-center rounded-xl opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-40 sm:h-9 sm:w-9 ${FOCUS_RING}`;

/**
 * Menu items that move focus somewhere else (an inline field, a confirm
 * button) must stop Radix from returning focus to the ⋯ trigger as the menu
 * closes. handoff(fn) runs fn in place of that return.
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

/**
 * An inline name field (rename, new folder). Enter saves; Esc, or leaving it
 * unchanged, cancels. It handles its own Esc (and stops it) so the overview's
 * Esc doesn't also leave Select mode.
 */
export function InlineNameInput({
  initial = "",
  label,
  placeholder,
  onSave,
  onCancel,
  className = "",
  tone = "card",
}: {
  initial?: string;
  label: string;
  placeholder?: string;
  /** Resolves to an error message to show (the field stays open), or nothing when saved. */
  onSave: (name: string) => Promise<string | void>;
  onCancel: () => void;
  className?: string;
  /** Colours for a card (navy) or a folder tile (orange). */
  tone?: "card" | "folder";
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();

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

  const ink = tone === "folder" ? "text-[var(--folder-ink)] border-[var(--folder-ink)]" : "text-[var(--card-title)] border-[var(--card-sub)]";
  return (
    <div data-inline-edit className={`relative z-10 ${className}`}>
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          value={value}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
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
          className={`min-h-11 min-w-0 flex-1 rounded-lg border bg-[var(--editor-bg)] px-2.5 text-[16px] outline-none placeholder:text-[var(--card-untitled)] sm:min-h-9 ${ink} ${FOCUS_RING}`}
        />
        {saving && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-[13px] text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** The red "delete this?" confirm. Delete gets focus; Esc cancels. In dark mode the ring is red-300
 *  (red-700 on the red-950/60 group is only about 2.6:1). */
export function ConfirmRow({ label, children, working, onConfirm, onCancel, className = "" }: { label: string; children: ReactNode; working: boolean; onConfirm: () => void; onCancel: () => void; className?: string }) {
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
      className={`relative z-10 flex flex-wrap items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-[14px] text-red-950 dark:bg-red-950/60 dark:text-red-100 ${className}`}
    >
      <p className="min-w-0 basis-full break-words">{children}</p>
      <button
        type="button"
        autoFocus
        data-confirm-delete
        disabled={working}
        onClick={onConfirm}
        className="flex min-h-11 shrink-0 items-center gap-1 rounded-md bg-red-700 px-3 text-[13px] font-semibold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 dark:focus-visible:outline-red-300 disabled:opacity-50 sm:min-h-8"
      >
        {working && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />} Delete
      </button>
      <button type="button" onClick={onCancel} className="min-h-11 shrink-0 rounded-md px-2 text-[13px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current sm:min-h-8">
        Cancel
      </button>
    </div>
  );
}

/** "No folder" then each folder; the current one is checked and disabled. */
export function MoveToFolderItems({
  folders,
  current,
  onMove,
}: {
  folders: DocumentFolder[];
  /** The documents' current folder (null = top level); undefined when mixed or unknown. */
  current: string | null | undefined;
  onMove: (folderId: string | null) => void;
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
    </>
  );
}
