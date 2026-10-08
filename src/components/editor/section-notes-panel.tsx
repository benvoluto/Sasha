"use client";

// The Section notes panel (PLAN §4.5): the writer's notes for the section the
// caret is in, typed or dictated, saved on their own (not with the document,
// so notes and body edits never trip each other's conflict check). The action
// button turns the notes into the section: Draft from notes when the section is
// empty, Rewrite from notes when it has text.

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, MicrophoneIcon, SparkleIcon, X } from "@/components/icons";
import { useSpeechToText } from "@/hooks/use-speech-to-text";
import { notesActionMode, type SectionResponse } from "@/lib/sections/contract";
import { PanelHeader } from "./side-panels";
import { sectionBodyRange, sectionHeadingIndexAt, type SectionBody } from "./tracked-range";
import type { GenerationRequest } from "./use-section-generation";

const SAVE_DELAY_MS = 800;

/**
 * The sectionId of the section holding the caret, as drafting reads sections
 * (sectionBodyRange): a sub-heading without a specKey is part of the section
 * above it, so its notes and Draft from notes are the parent's.
 */
export function caretSectionId(editor: Editor): string | null {
  const { doc, selection } = editor.state;
  if (doc.childCount === 0) return null;
  const at = sectionHeadingIndexAt(doc, selection.$head.index(0));
  return at < 0 ? null : (doc.child(at).attrs.sectionId as string | null) || null;
}

export function useCaretSectionId(editor: Editor | null): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    const read = () => setId(caretSectionId(editor));
    read();
    editor.on("selectionUpdate", read);
    editor.on("update", read);
    return () => {
      editor.off("selectionUpdate", read);
      editor.off("update", read);
    };
  }, [editor]);
  return id;
}

function useSection(editor: Editor, sectionId: string | null): SectionBody | null {
  const [section, setSection] = useState<SectionBody | null>(() => (sectionId ? sectionBodyRange(editor.state.doc, sectionId) : null));
  useEffect(() => {
    const read = () => setSection(sectionId ? sectionBodyRange(editor.state.doc, sectionId) : null);
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor, sectionId]);
  return section;
}

function dictationError(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone blocked. Allow it in your browser's site settings to dictate.";
  if (code === "audio-capture") return "No microphone was found.";
  if (code === "network") return "Dictation needs an internet connection in this browser.";
  return `Dictation stopped (${code}).`;
}

type SaveState = "idle" | "saving" | "saved" | "error";

type PendingNotes = { sectionId: string; notes: string; specKey: string | null };

/** Where a dictation started: its section, and the notes it is added to. */
export type DictationStart = { sectionId: string; specKey: string | null; base: string };

/** The dictated text after the notes that were there. */
export function joinDictation(base: string, said: string): string {
  const sep = base && said ? (base.endsWith("\n") ? "" : " ") : "";
  return base + sep + said;
}

/**
 * The save a finished dictation makes. It always goes to the section the
 * dictation started in, even if the caret (and so the panel) has since moved.
 */
export function dictationSave(started: DictationStart, said: string): PendingNotes {
  return { sectionId: started.sectionId, specKey: started.specKey, notes: joinDictation(started.base, said) };
}

/**
 * True when recognition went from listening to stopped while a dictation was
 * still open, i.e. it ended without Finish or Cancel (both close the dictation
 * before stopping). Before the first listening=true (start pending) it isn't.
 */
export function dictationEnded(wasListening: boolean, listening: boolean, dictating: boolean): boolean {
  return wasListening && !listening && dictating;
}

export function SectionNotesPanel({
  editor,
  documentId,
  ensureSaved,
  sectionId,
  busy,
  run,
  onSaved,
  onClose,
}: {
  editor: Editor;
  documentId: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** The section to show: the one holding the caret. */
  sectionId: string | null;
  busy: ReadonlySet<string>;
  run: (req: GenerationRequest) => Promise<string | null>;
  /** Notes were saved for a section (keeps the outline's notes marker current). */
  onSaved: (sectionId: string, notes: string) => void;
  onClose: () => void;
}) {
  const section = useSection(editor, sectionId);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // The edit waiting to be saved, and its timer.
  const pending = useRef<PendingNotes | null>(null);
  const timer = useRef<number | null>(null);
  const docIdRef = useRef(documentId);
  docIdRef.current = documentId;
  const specKeyRef = useRef<string | null>(section?.specKey ?? null);
  specKeyRef.current = section?.specKey ?? null;

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    if (!p) return true;
    pending.current = null;
    setSaveState("saving");
    try {
      const id = docIdRef.current || (await ensureSaved());
      if (!id) throw new Error("Couldn't save");
      const res = await fetch(`/api/documents/${encodeURIComponent(id)}/sections/${encodeURIComponent(p.sectionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: p.notes, specKey: p.specKey }),
      });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        throw new Error(typeof out.error === "string" ? out.error : `Couldn't save (${res.status})`);
      }
      onSaved(p.sectionId, p.notes);
      // A newer edit may have queued meanwhile; its own timer saves it.
      if (!pending.current) setSaveState("saved");
      setSaveError(null);
      return true;
    } catch (e) {
      // Keep the edit for Retry unless a newer one replaced it.
      pending.current ??= p;
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : "Couldn't save");
      return false;
    }
  }, [ensureSaved, onSaved]);

  const queue = useCallback(
    (text: string, delay = SAVE_DELAY_MS) => {
      if (!sectionId) return;
      pending.current = { sectionId, notes: text, specKey: specKeyRef.current };
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), delay);
      setSaveState("idle");
    },
    [sectionId, save],
  );

  // Dictation: the transcript shows live after the text that was there (deskapp ChatInput's Finish/Cancel).
  const { supported, listening, transcript, error: micError, start, stop } = useSpeechToText();
  /** The running dictation's section and starting notes; null when not dictating. */
  const dictation = useRef<DictationStart | null>(null);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  /** Stop the running dictation and queue its text for the section it started in. Returns the new notes, or null if none was running. */
  const commitDictation = useCallback((): string | null => {
    const started = dictation.current;
    if (!started) return null;
    dictation.current = null;
    const said = stop() || transcriptRef.current;
    pending.current = dictationSave(started, said);
    return pending.current.notes;
  }, [stop]);

  // Another section (or document): finish a dictation into the section it
  // belongs to, save what's pending for the old one, then load the new one.
  useEffect(() => {
    commitDictation();
    void save();
    setNotes("");
    setSaveState("idle");
    setSaveError(null);
    setRunError(null);
    setLoadError(null);
    if (!sectionId || !documentId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/sections/${encodeURIComponent(sectionId)}`, { cache: "no-store" });
        const out = (await res.json().catch(() => ({}))) as Partial<SectionResponse> & { error?: string };
        if (!res.ok) throw new Error(out.error ?? `Couldn't load the notes (${res.status}).`);
        if (!cancelled) setNotes(out.section?.notes ?? "");
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load the notes.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // documentId changes when a new document is first saved; its notes are already in hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  // Closing the panel or leaving the page: keep a dictation still running
  // (its words are on screen but not yet queued), then save what's left. Read
  // through refs so the cleanup sees the latest callbacks without re-running.
  const saveRef = useRef(save);
  saveRef.current = save;
  const commitRef = useRef(commitDictation);
  commitRef.current = commitDictation;
  useEffect(
    () => () => {
      commitRef.current();
      void saveRef.current();
    },
    [],
  );

  // Recognition stopped by itself (a permanent error, the short-run guard, the
  // native shell ending it): keep what was said, as Finish would.
  const wasListening = useRef(listening);
  useEffect(() => {
    const ended = dictationEnded(wasListening.current, listening, !!dictation.current);
    wasListening.current = listening;
    if (!ended) return;
    const started = dictation.current;
    const next = commitDictation();
    if (next === null) return;
    if (started?.sectionId === sectionId) setNotes(next);
    void save();
  }, [listening, sectionId, commitDictation, save]);

  // Show the transcript live, but only while the dictation's own section is on screen.
  useEffect(() => {
    const started = dictation.current;
    if (!listening || !started || started.sectionId !== sectionId) return;
    setNotes(joinDictation(started.base, transcript));
  }, [transcript, listening, sectionId]);

  const startDictation = () => {
    if (!sectionId) return;
    dictation.current = { sectionId, specKey: specKeyRef.current, base: notes };
    start();
  };
  const finishDictation = () => {
    const next = commitDictation();
    if (next === null) return;
    setNotes(next);
    void save();
  };
  const cancelDictation = () => {
    const started = dictation.current;
    dictation.current = null;
    stop();
    if (started) setNotes(started.base);
  };

  const mode = section ? notesActionMode(section.bodyText, notes) : null;
  const isBusy = !!sectionId && busy.has(sectionId);

  const runFromNotes = async () => {
    if (!sectionId || !mode) return;
    setRunError(null);
    if (pending.current) await save();
    const err = await run({ sectionId, mode, notes });
    if (err) setRunError(err);
  };

  const status =
    saveState === "saving" ? (
      <>
        <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Saving…
      </>
    ) : saveState === "saved" ? (
      "Saved"
    ) : saveState === "error" ? (
      <>
        {saveError ?? "Couldn't save"} —{" "}
        <button type="button" onClick={() => void save()} className="font-semibold underline underline-offset-2">
          Retry
        </button>
      </>
    ) : null;

  return (
    <aside aria-label="Section notes" className="flex h-full flex-col">
      <PanelHeader title="Section notes" onClose={onClose} />
      {!sectionId || !section ? (
        <p className="px-5 text-sm text-[var(--doc-muted)]">Put the caret in a section to see its notes. Notes belong to the section under a heading.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-6">
          <p className="truncate text-base font-semibold" title={section.heading}>
            {section.heading || "Untitled section"}
          </p>
          <div
            className={`rounded-lg border bg-transparent transition-colors ${listening ? "border-[var(--doc-accent)]" : "border-[var(--doc-line)] focus-within:border-[var(--doc-accent)]"}`}
          >
            <label htmlFor="section-notes" className="sr-only">
              Notes for {section.heading || "this section"}
            </label>
            <textarea
              id="section-notes"
              value={notes}
              readOnly={listening || loading}
              onChange={(e) => {
                setNotes(e.target.value);
                queue(e.target.value);
              }}
              rows={10}
              placeholder={listening ? "Listening…" : loading ? "Loading…" : "Facts, points to make, rough wording… Claude drafts the section from these."}
              className="block w-full resize-y rounded-lg bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none"
            />
            <div className="flex items-center justify-between gap-2 border-t border-[var(--doc-line)] px-2 py-1.5">
              <span role="status" aria-live="polite" className={`min-w-0 text-xs ${saveState === "error" ? "text-red-600 dark:text-red-400" : "text-[var(--doc-muted)]"}`}>
                {status}
              </span>
              {listening ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <MicrophoneIcon className="h-5 w-5 shrink-0 animate-pulse text-[var(--doc-accent)]" weight="fill" aria-label="Recording" />
                  <button
                    type="button"
                    onClick={finishDictation}
                    aria-label="Finish dictation"
                    className="flex items-center gap-1 rounded-full bg-[var(--doc-accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--doc-ink)]"
                  >
                    <Check className="h-3.5 w-3.5" /> Finish
                  </button>
                  <button
                    type="button"
                    onClick={cancelDictation}
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
                    disabled={loading}
                    onClick={startDictation}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-accent)] disabled:opacity-40"
                  >
                    <MicrophoneIcon className="h-5 w-5" />
                  </button>
                )
              )}
            </div>
          </div>
          {micError && <p className="text-sm text-red-600 dark:text-red-400">{dictationError(micError)}</p>}
          {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
          {mode && (
            <button
              type="button"
              disabled={isBusy || listening}
              onClick={() => void runFromNotes()}
              className="flex items-center justify-center gap-1.5 self-start rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SparkleIcon className="h-4 w-4" />}
              {isBusy ? "Claude is writing…" : mode === "draft_from_notes" ? "Draft from notes" : "Rewrite from notes"}
            </button>
          )}
          {runError && <p className="text-sm text-red-600 dark:text-red-400">{runError}</p>}
          <p className="text-xs text-[var(--doc-muted)]">
            {mode === "rewrite_from_notes"
              ? "Rewriting replaces the section's text. A version is saved first, and Undo reverses it."
              : "Notes are saved with the document but stay out of its text."}
            {supported ? " Dictation uses your browser's speech recognition; Sasha keeps no audio." : ""}
          </p>
        </div>
      )}
    </aside>
  );
}
