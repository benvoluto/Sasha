"use client";

// A notes textarea with live dictation (use-speech-to-text): the field, a
// status line and the mic / Finish / Cancel footer. Shared by the Section notes
// panel and the document modal's Notes tab. The field only draws; each pane
// owns its dictation (where the words go, when they are saved). The pure
// helpers below hold the rules both panes follow. No audio is kept: the
// browser or the native shell does the recognition and only text comes back.

import type { ReactNode, Ref } from "react";
import { Check, MicrophoneIcon, X } from "@/components/icons";

/** The dictated text after the notes that were there. */
export function joinDictation(base: string, said: string): string {
  const sep = base && said ? (base.endsWith("\n") ? "" : " ") : "";
  return base + sep + said;
}

/**
 * True when recognition went from listening to stopped while a dictation was
 * still open, i.e. it ended without Finish or Cancel (both close the dictation
 * before stopping). Before the first listening=true (start pending) it isn't.
 */
export function dictationEnded(wasListening: boolean, listening: boolean, dictating: boolean): boolean {
  return wasListening && !listening && dictating;
}

/** What to tell the person when recognition reports an error code. */
export function dictationError(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone blocked. Allow it in your browser's site settings to dictate.";
  if (code === "audio-capture") return "No microphone was found.";
  if (code === "network") return "Dictation needs an internet connection in this browser.";
  return `Dictation stopped (${code}).`;
}

/** An open dictation: the notes it is added to, and where the caret was when it started. Null when not dictating. */
export type Dictation = { base: string; caret: number | null } | null;

export type DictationAction =
  | { type: "start"; base: string; caret?: number | null }
  /** Finish, an unexpected end, or the pane closing: keep what was said. */
  | { type: "commit"; said: string }
  | { type: "cancel" };

/**
 * One step of a dictation. `commit` is the text to save (once) and `restore`
 * the text to put back; at most one is set. Commit or cancel with nothing open
 * does nothing, so Finish and the end-of-recognition effect can't both save.
 */
export function dictationReducer(state: Dictation, action: DictationAction): { state: Dictation; commit: string | null; restore: string | null } {
  switch (action.type) {
    case "start":
      // A second start while one is open keeps the first one's base.
      return { state: state ?? { base: action.base, caret: action.caret ?? null }, commit: null, restore: null };
    case "commit":
      return state ? { state: null, commit: joinDictation(state.base, action.said), restore: null } : { state, commit: null, restore: null };
    case "cancel":
      return state ? { state: null, commit: null, restore: state.base } : { state, commit: null, restore: null };
  }
}

export function DictationField({
  id,
  label,
  value,
  onChange,
  placeholder,
  readOnly = false,
  listening,
  supported,
  micDisabled = false,
  onStart,
  onFinish,
  onCancel,
  status,
  statusError = false,
  fill = false,
  rows = 10,
  maxLength,
  textareaRef,
}: {
  id: string;
  /** The field's accessible name (visually hidden). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Read-only on top of while listening (e.g. while loading). */
  readOnly?: boolean;
  /** A dictation is running: the field is read-only and the footer shows Finish / Cancel. */
  listening: boolean;
  /** Speech recognition is available; the mic button is hidden otherwise. */
  supported: boolean;
  micDisabled?: boolean;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
  /** The status line at the left of the footer (save state, character count). */
  status: ReactNode;
  statusError?: boolean;
  /** Grow to fill a flex column (the Notes tab) instead of a fixed number of rows. */
  fill?: boolean;
  rows?: number;
  maxLength?: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <div
      className={`flex flex-col rounded-lg border bg-transparent transition-colors ${fill ? "min-h-0 flex-1" : ""} ${
        listening ? "border-[var(--doc-accent)]" : "border-[var(--doc-field-line)] focus-within:border-[var(--doc-accent)] focus-within:ring-2 focus-within:ring-[var(--doc-accent)]"
      }`}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        readOnly={listening || readOnly}
        aria-readonly={listening || readOnly || undefined}
        onChange={(e) => onChange(e.target.value)}
        rows={fill ? undefined : rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className={`block w-full rounded-lg bg-transparent px-3 py-2.5 leading-relaxed outline-none ${fill ? "min-h-0 flex-1 resize-none text-[15px]" : "resize-y text-sm"}`}
      />
      <div className="flex items-center justify-between gap-2 border-t border-[var(--doc-line)] px-2 py-1.5">
        <span role="status" aria-live="polite" className={`min-w-0 text-xs ${statusError ? "text-red-600 dark:text-red-400" : "text-[var(--doc-muted)]"}`}>
          {status}
        </span>
        {listening ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <MicrophoneIcon className="h-5 w-5 shrink-0 animate-pulse text-[var(--doc-accent)] motion-reduce:animate-none" weight="fill" aria-label="Recording" />
            <button
              type="button"
              onClick={onFinish}
              aria-label="Finish dictation"
              className="flex items-center gap-1 rounded-full bg-[var(--doc-accent)] px-2.5 py-1 text-xs font-medium text-[var(--doc-on-accent)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--doc-ink)]"
            >
              <Check className="h-3.5 w-3.5" /> Finish
            </button>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel dictation"
              className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          supported && (
            <button
              type="button"
              aria-label="Dictate notes"
              title="Dictate"
              disabled={micDisabled}
              onClick={onStart}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-accent)] disabled:opacity-40"
            >
              <MicrophoneIcon className="h-5 w-5" />
            </button>
          )
        )}
      </div>
    </div>
  );
}
