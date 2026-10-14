"use client";

// Saving a standalone note from the note dialog: edits are debounced 800ms and
// PATCHed with the updated_at last seen (base_updated_at), one request at a
// time. A 409 holds further saves and keeps the server's note as `conflict`
// until the person picks "Load theirs" or "Keep mine" (re-saved without a
// base). `flush` sends what's pending now (Done, Start a document); a hidden
// or closing tab sends it with keepalive.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, NoteConflictResponse, NoteResponse } from "@/lib/notes/contract";
import type { SaveStatus } from "@/components/editor/use-document";
import { noteSaveError } from "./notes-model";

export const NOTE_SAVE_DEBOUNCE_MS = 800;

export type NoteSave = {
  body: string;
  /** The latest text, read synchronously (after a dictation is finished on close). */
  current: () => string;
  setBody: (body: string) => void;
  status: SaveStatus;
  error: string | null;
  /** The server's note after a 409, until resolved. */
  conflict: Note | null;
  /** Send pending edits now; true when nothing is left unsaved. */
  flush: () => Promise<boolean>;
  loadTheirs: () => void;
  keepMine: () => Promise<void>;
  /** Drop pending edits (the note is being deleted). */
  discard: () => void;
};

export function useNoteSave(note: Note, onSaved: (note: Note) => void): NoteSave {
  const [body, setBodyState] = useState(note.body);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Note | null>(null);
  const bodyRef = useRef(note.body);
  const base = useRef(note.updated_at);
  const dirty = useRef(false);
  const conflictRef = useRef<Note | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const id = note.id;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const send = useCallback(
    async (force: boolean) => {
      if (!dirty.current || (conflictRef.current && !force)) return;
      const sent = bodyRef.current;
      dirty.current = false;
      setStatus("saving");
      try {
        const res = await fetch(`/api/notes/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(force ? { body: sent } : { body: sent, base_updated_at: base.current }),
        });
        const data = (await res.json().catch(() => null)) as (NoteResponse & NoteConflictResponse) | null;
        if (res.ok && data?.note) {
          base.current = data.note.updated_at;
          conflictRef.current = null;
          setConflict(null);
          setError(null);
          // Typed while the request was out: the timer set by that edit saves it.
          if (!dirty.current) setStatus("saved");
          onSavedRef.current(data.note);
          return;
        }
        dirty.current = true;
        if (res.status === 409 && data?.note) {
          conflictRef.current = data.note;
          setConflict(data.note);
          setStatus("conflict");
          return;
        }
        setStatus("error");
        setError(noteSaveError(res.status, data?.error));
      } catch {
        dirty.current = true;
        setStatus("error");
        setError("Not saved: check your connection.");
      }
    },
    [id],
  );

  const enqueue = useCallback(
    (force = false) => {
      chain.current = chain.current.then(() => send(force));
      return chain.current;
    },
    [send],
  );

  const setBody = useCallback(
    (text: string) => {
      bodyRef.current = text;
      setBodyState(text);
      dirty.current = true;
      clearTimer();
      if (!conflictRef.current) timer.current = setTimeout(() => void enqueue(), NOTE_SAVE_DEBOUNCE_MS);
    },
    [enqueue],
  );

  const flush = useCallback(async () => {
    clearTimer();
    await enqueue();
    return !dirty.current;
  }, [enqueue]);

  const loadTheirs = useCallback(() => {
    const theirs = conflictRef.current;
    if (!theirs) return;
    clearTimer();
    conflictRef.current = null;
    setConflict(null);
    bodyRef.current = theirs.body;
    setBodyState(theirs.body);
    base.current = theirs.updated_at;
    dirty.current = false;
    setStatus("saved");
    setError(null);
    onSavedRef.current(theirs);
  }, []);

  const keepMine = useCallback(async () => {
    clearTimer();
    conflictRef.current = null;
    setConflict(null);
    dirty.current = true;
    await enqueue(true);
  }, [enqueue]);

  const discard = useCallback(() => {
    clearTimer();
    dirty.current = false;
  }, []);

  // A tab hidden or closed mid-debounce: send now, with keepalive (a note is
  // at most a few hundred KB; past the 64KB keepalive limit the browser drops
  // the flag and it's a normal request).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden" || !dirty.current || conflictRef.current) return;
      clearTimer();
      const sent = bodyRef.current;
      const payload = JSON.stringify({ body: sent, base_updated_at: base.current });
      void fetch(`/api/notes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: payload, keepalive: payload.length < 60_000 })
        .then(async (res) => {
          const data = (await res.json().catch(() => null)) as NoteResponse | null;
          if (res.ok && data?.note) {
            base.current = data.note.updated_at;
            if (bodyRef.current === sent) dirty.current = false;
            onSavedRef.current(data.note);
          }
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [id]);

  // Unmounted with edits still pending (the dialog normally flushes first).
  useEffect(
    () => () => {
      clearTimer();
      if (dirty.current && !conflictRef.current) void send(false);
    },
    [send],
  );

  return { body, current: () => bodyRef.current, setBody, status, error, conflict, flush, loadTheirs, keepMine, discard };
}
