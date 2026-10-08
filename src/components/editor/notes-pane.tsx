"use client";

// The Notes tab: one running scratchpad for the document (PLAN §6.2,
// decisions 15–18), saved through the document's own save queue (onChange is
// use-document's change({ notes }): debounced, retried, sent on hide, conflict
// checked with the body). Live dictation (use-speech-to-text) with Finish /
// Cancel, mic hidden when unsupported. While dictating the field is read-only
// and shows the notes plus the words so far; nothing is saved until Finish (or
// an unexpected end, or the pane closing), and Cancel puts the notes back. No
// audio is kept: only text reaches onChange.

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Loader2 } from "@/components/icons";
import { useSpeechToText } from "@/hooks/use-speech-to-text";
import { MAX_DOCUMENT_NOTES } from "@/lib/documents/notes-contract";
import { DictationField, dictationEnded, dictationError, dictationReducer, joinDictation, type Dictation, type DictationAction } from "./dictation-field";
import type { SaveStatus } from "./use-document";

export const NOTES_PLACEHOLDER = "Anything about this document: who it's for, what it must cover, facts to work in. Dictate or type.";

/** What the document modal needs from the pane: Esc cancels a running dictation instead of closing. */
export type NotesPaneHandle = { dictating: () => boolean; cancelDictation: () => void };

/** The status line's save text. The save status is the document's (notes share its queue). */
export function notesSaveText(status: SaveStatus, error: string | null): string {
  if (status === "saving") return "Saving…";
  if (status === "saved") return "Saved";
  if (status === "error") return error || "Not saved";
  if (status === "conflict") return "Not saved";
  return "";
}

/** A quiet character count once the notes are within 10% of the cap; null before that. */
export function notesCount(length: number, max = MAX_DOCUMENT_NOTES): string | null {
  if (length < max * 0.9) return null;
  return `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} characters`;
}

/** Notes as saved: never longer than the server accepts (a long dictation is cut at the cap). */
export function capNotes(text: string, max = MAX_DOCUMENT_NOTES): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function NotesPane({
  notes,
  onChange,
  saveStatus,
  saveError = null,
  controlRef,
}: {
  notes: string;
  onChange: (notes: string) => void;
  saveStatus: SaveStatus;
  /** The save error's text, shown when saveStatus is "error". */
  saveError?: string | null;
  controlRef?: Ref<NotesPaneHandle>;
}) {
  const { supported, listening, transcript, error: micError, start, stop } = useSpeechToText();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The open dictation lives in a ref (Finish, the end-of-recognition effect
  // and unmount read it synchronously) mirrored into state for rendering.
  const dictation = useRef<Dictation>(null);
  const [active, setActive] = useState<Dictation>(null);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const step = useCallback((action: DictationAction) => {
    const r = dictationReducer(dictation.current, action);
    dictation.current = r.state;
    setActive(r.state);
    return r;
  }, []);

  /** Put the caret at `pos` once the field is editable again. */
  const placeCaret = (pos: number | null) => {
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el?.isConnected) return;
      el.focus();
      if (pos !== null) el.setSelectionRange(pos, pos);
    });
  };

  /**
   * Close the open dictation and save base + what was said, once. `stopFirst`
   * is false when recognition already ended by itself. Returns the saved notes,
   * or null when no dictation was open.
   */
  const commit = useCallback(
    (stopFirst: boolean): string | null => {
      if (!dictation.current) return null;
      // stop() returns the full transcript, including words not yet in React state.
      const said = (stopFirst ? stop() : "") || transcriptRef.current;
      const { commit: text } = step({ type: "commit", said });
      if (text === null) return null;
      const next = capNotes(text);
      if (next !== notesRef.current) onChangeRef.current(next);
      return next;
    },
    [stop, step],
  );

  const cancel = useCallback(() => {
    // Close first, so the stop that follows doesn't read as an unexpected end.
    const { restore } = step({ type: "cancel" });
    stop();
    return restore;
  }, [stop, step]);

  const startDictation = () => {
    const el = textareaRef.current;
    step({ type: "start", base: notes, caret: el ? el.selectionStart : null });
    start();
  };
  const finishDictation = () => {
    const next = commit(true);
    if (next !== null) placeCaret(next.length);
  };
  const cancelDictation = useCallback(() => {
    const caret = dictation.current?.caret ?? null;
    if (cancel() !== null) placeCaret(caret);
  }, [cancel]);

  useImperativeHandle(controlRef, () => ({ dictating: () => dictation.current !== null, cancelDictation }), [cancelDictation]);

  // Recognition stopped by itself (a permanent error, the short-run guard, the
  // native shell ending it): keep what was said, as Finish would.
  const wasListening = useRef(listening);
  useEffect(() => {
    const ended = dictationEnded(wasListening.current, listening, dictation.current !== null);
    wasListening.current = listening;
    if (ended) commit(false);
  }, [listening, commit]);

  // Recognition refused before it ever started (microphone blocked): nothing
  // was said, so close the dictation and give the field back.
  useEffect(() => {
    if (micError && !listening && dictation.current) commit(false);
  }, [micError, listening, commit]);

  // The pane unmounts when the dialog closes or another tab opens: a running
  // dictation is kept, as on an unexpected end.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => void commitRef.current(true), []);

  const shown = active ? capNotes(joinDictation(active.base, transcript)) : notes;
  const count = notesCount(shown.length);
  const saveText = active ? "Listening… Finish to keep it, or cancel." : notesSaveText(saveStatus, saveError);
  const statusError = !active && (saveStatus === "error" || saveStatus === "conflict");
  const status = (
    <>
      {!active && saveStatus === "saving" && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
      {saveText}
      {count && (
        <span className={saveText ? "ml-2" : undefined}>
          {saveText ? "· " : ""}
          {count}
        </span>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
      <DictationField
        id="document-notes"
        label="Notes"
        value={shown}
        onChange={(text) => onChange(capNotes(text))}
        placeholder={active ? "Listening…" : NOTES_PLACEHOLDER}
        readOnly={!!active}
        // Finish / Cancel from the moment the mic is pressed, so a start that never takes can still be closed.
        listening={listening || !!active}
        supported={supported}
        onStart={startDictation}
        onFinish={finishDictation}
        onCancel={cancelDictation}
        status={status}
        statusError={statusError}
        fill
        maxLength={MAX_DOCUMENT_NOTES}
        textareaRef={textareaRef}
      />
      {micError && <p className="text-sm text-red-600 dark:text-red-400">{dictationError(micError)}</p>}
      <p className="text-xs text-[var(--doc-muted)]">
        Saved with the document; Claude reads them when suggesting a type and sources.
        {supported ? " Dictation uses your browser's speech recognition; Sasha keeps no audio." : ""}
      </p>
    </div>
  );
}
