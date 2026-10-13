"use client";

// One standalone note open for editing (redesign3-spec.md §7): the document
// modal's NotesPane (dictation included) saved through useNoteSave, with
// "Start a document", "Delete note" (inline confirm) and "Done". Closing
// (Done, Esc, the X) finishes a running dictation and flushes the save first;
// a save that fails keeps the dialog open so nothing is lost. A note closed
// blank is deleted silently. Esc cancels a running dictation or the delete
// confirm before it closes anything.

import { useEffect, useRef, useState } from "react";
import { Loader2, StartDocumentIcon, Trash2 } from "@/components/icons";
import { NotesPane, type NotesPaneHandle } from "@/components/editor/notes-pane";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Note, StartDocumentResponse } from "@/lib/notes/contract";
import { isBlankNote } from "./notes-model";
import { useNoteSave } from "./use-note-save";

export const NOTE_TEXTAREA_ID = "standalone-note";

const NOTE_PLACEHOLDER = "Anything worth keeping. Type or dictate; the first line is the title.";
const NOTE_HINT = "Shared with your team and saved as you go. Start a document to make it a document's notes.";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--doc-accent)]";
const quietButton = `inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium sm:min-h-9 disabled:opacity-50 ${focusRing}`;

export function NoteDialog({
  note,
  onSaved,
  onDeleted,
  onStarted,
  onClosed,
  returnFocus,
}: {
  note: Note;
  /** Each save (and "Load theirs"): the card updates before the next fetch. */
  onSaved: (note: Note) => void;
  /** The note is gone (deleted, closed blank, or turned into a document). */
  onDeleted: (id: string) => void;
  /** "Start a document" made this document; the caller opens it. */
  onStarted: (document: StartDocumentResponse["document"]) => void;
  /** The dialog finished closing; the caller unmounts it and refreshes the feed. */
  onClosed: () => void;
  /** Where focus goes once the dialog has closed (the note's card, or the New note card). */
  returnFocus: () => void;
}) {
  const save = useNoteSave(note, onSaved);
  const pane = useRef<NotesPaneHandle>(null);
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"close" | "start" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // The inline confirm takes focus, and gives it back to "Delete note" when cancelled.
  useEffect(() => {
    if (confirming) confirmCancel.current?.focus();
    else if (wasConfirming.current) deleteButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const finishClosing = () => {
    setOpen(false);
    onClosed();
  };

  const remove = async (): Promise<boolean> => {
    save.discard();
    const res = await fetch(`/api/notes/${note.id}`, { method: "DELETE" }).catch(() => null);
    // Already gone counts as deleted.
    if (!res || (!res.ok && res.status !== 404)) return false;
    onDeleted(note.id);
    return true;
  };

  const requestClose = async () => {
    if (busy) return;
    pane.current?.finishDictation();
    setActionError(null);
    if (isBlankNote(save.current())) {
      setBusy("close");
      await remove();
      finishClosing();
      return;
    }
    setBusy("close");
    const saved = await save.flush();
    setBusy(null);
    // The status line (or the conflict bar) says why; the text stays here.
    if (saved) finishClosing();
  };

  const startDocument = async () => {
    if (busy) return;
    pane.current?.finishDictation();
    setActionError(null);
    setBusy("start");
    if (!(await save.flush())) {
      setBusy(null);
      return;
    }
    const res = await fetch(`/api/notes/${note.id}/start-document`, { method: "POST" }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as StartDocumentResponse | null) : null;
    if (!data?.document) {
      setBusy(null);
      setActionError("Couldn't start a document. Try again.");
      return;
    }
    onDeleted(note.id);
    setOpen(false);
    onStarted(data.document);
  };

  const confirmDelete = async () => {
    setBusy("delete");
    setActionError(null);
    if (await remove()) {
      finishClosing();
      return;
    }
    setBusy(null);
    setActionError("Couldn't delete the note. Try again.");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => void (!o && requestClose())}>
      <DialogContent
        className="flex h-[min(85dvh,40rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border-[var(--doc-line)] bg-[var(--doc-surface)] p-0 font-sans text-[var(--doc-ink)] sm:max-w-2xl"
        onEscapeKeyDown={(e) => {
          if (pane.current?.dictating()) {
            e.preventDefault();
            pane.current.cancelDictation();
          } else if (confirming) {
            e.preventDefault();
            setConfirming(false);
          }
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader className="px-4 pb-3 pr-12 pt-5 text-left sm:px-6 sm:pr-14 sm:pt-6">
          <DialogTitle className="text-xl font-semibold tracking-tight">Note</DialogTitle>
          <DialogDescription className="sr-only">A note of your own. Type or dictate; it saves as you go.</DialogDescription>
        </DialogHeader>

        {save.conflict && (
          <div
            role="alert"
            className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--alert-warn-line)] bg-[var(--alert-warn-bg)] px-3 py-2 text-sm text-[var(--alert-warn-ink)] sm:mx-6"
          >
            <span className="flex-1">Someone else changed this note.</span>
            <button
              type="button"
              onClick={save.loadTheirs}
              className="min-h-11 rounded-md border border-current px-3 py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--alert-warn-ink)] sm:min-h-8"
            >
              Load theirs
            </button>
            <button
              type="button"
              onClick={() => void save.keepMine()}
              className="min-h-11 rounded-md bg-[var(--alert-warn-ink)] px-3 py-1 font-medium text-[var(--alert-warn-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--alert-warn-ink)] sm:min-h-8"
            >
              Keep mine
            </button>
          </div>
        )}

        <NotesPane
          controlRef={pane}
          id={NOTE_TEXTAREA_ID}
          label="Note"
          placeholder={NOTE_PLACEHOLDER}
          hint={NOTE_HINT}
          notes={save.body}
          onChange={save.setBody}
          saveStatus={save.status}
          saveError={save.error}
          autoFocus
        />

        {actionError && (
          <p role="alert" className="px-4 pb-2 text-sm text-[var(--alert-danger-ink)] sm:px-6">
            {actionError}
          </p>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--doc-line)] px-4 py-3 sm:px-6">
          {confirming ? (
            <div role="group" aria-label="Delete this note?" className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Delete this note?</span>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy !== null}
                className={`${quietButton} bg-[var(--alert-danger-ink)] text-[var(--doc-surface)]`}
              >
                {busy === "delete" && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete
              </button>
              <button ref={confirmCancel} type="button" onClick={() => setConfirming(false)} disabled={busy !== null} className={`${quietButton} hover:bg-[var(--doc-accent-soft)]`}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              ref={deleteButton}
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              className={`${quietButton} text-[var(--alert-danger-ink)] hover:bg-[var(--doc-accent-soft)]`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete note
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void startDocument()}
              disabled={busy !== null || confirming}
              className={`${quietButton} border border-[var(--doc-accent-line)] text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]`}
            >
              {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <StartDocumentIcon className="h-4 w-4" aria-hidden />}
              Start a document
            </button>
            <button
              type="button"
              onClick={() => void requestClose()}
              disabled={busy === "start" || busy === "delete"}
              className={`${quietButton} bg-[var(--doc-accent)] px-4 text-[var(--doc-on-accent)] hover:opacity-90`}
            >
              {busy === "close" && <Loader2 className="h-4 w-4 animate-spin" />}
              Done
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
