"use client";

// The empty-state helper beside Sasha at the bottom left of the editing
// screen (redesign2-spec.md §5): "Start writing, [upload sources], choose a
// [document type ⌃⌄] or just [tell me] what doc you'd like to create…", the
// "tell me" prompt form, and the tell-me progress and result. It dismisses
// itself once the first paragraph is written or the dog is clicked
// (remembered per document), and makes the dog a button while it shows.
// When it shows is decided by helper-model.ts.

import type { Editor } from "@tiptap/react";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, CaretUpDown, Loader2, UploadFileIcon } from "@/components/icons";
import { dogActionAtom } from "@/components/shell/dog-action";
import { TELL_ME_PROMPT_MAX, TELL_ME_PROMPT_MIN } from "@/lib/tell-me/contract";
import { hasText, helperVisible, readHelperDismissed, shouldDismiss, writeHelperDismissed } from "./helper-model";
import type { TellMe } from "./use-tell-me";
import { tellMeUndoNote } from "./use-tell-me-model";

export type EmptyHelperProps = {
  editor: Editor;
  /** The saved document's id, or null for a new one (dismissal is kept in memory until the id arrives). */
  documentId: string | null;
  /** The document's type: a typed document never shows the tips. */
  typeKey: string | null;
  tellMe: TellMe;
  /** "upload sources": the document modal on its Sources tab, in upload mode. */
  onUploadSources: () => void;
  /** "document type": the Document Gallery. */
  onChooseType: () => void;
  /** The editor area's left edge in viewport pixels (useColumnLayout's `left`): the helper is fixed at the bottom, just past it. */
  leftEdge: number;
  /** The right column is open over the text (drawer or sheet): the tips step aside, and the cards sit under its panels. */
  covered?: boolean;
  /** Whether the helper is showing, so the screen can hide the editor's own empty placeholder (.doc-helper-on). */
  onVisibleChange?: (visible: boolean) => void;
};

/** The character count appears past this many characters. */
const COUNT_FROM = 1500;

// Inline-block, not flex, so each link sits on the sentence's baseline.
const LINK =
  "inline-block rounded py-1 font-semibold text-[var(--helper-link)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--helper-link)]";
const CARD = "rounded-2xl border border-[var(--doc-line)] bg-[var(--editor-bg)] p-3 text-[15px] text-[var(--doc-ink)] shadow-lg outline-none";
const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--action)] px-3.5 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] disabled:opacity-60 sm:min-h-9 dark:text-[var(--editor-bg)]";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--doc-field-line)] px-3.5 font-medium text-[var(--doc-ink)] hover:bg-[var(--doc-surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] sm:min-h-9";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function EmptyHelper({ editor, documentId, typeKey, tellMe, onUploadSources, onChooseType, leftEdge, covered = false, onVisibleChange }: EmptyHelperProps) {
  const { state } = tellMe;
  const phase = state.phase;

  // --- Dismissal, per document ---------------------------------------------------
  // A document that opens with text already in it starts dismissed (nothing is stored).
  const [openedWithText] = useState(() => hasText(editor.state.doc));
  const [dismissedStored, setDismissed] = useState(() => (documentId ? readHelperDismissed(documentId) : false));
  const dismissed = dismissedStored || openedWithText;
  const idRef = useRef(documentId);
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;
  useEffect(() => {
    const prev = idRef.current;
    idRef.current = documentId;
    if (prev === documentId || !documentId) return;
    // A new document just got its id: keep what happened before it was saved.
    if (prev === null) {
      if (dismissedRef.current) writeHelperDismissed(documentId);
    } else setDismissed(readHelperDismissed(documentId));
  }, [documentId]);
  const dismiss = useCallback(() => {
    setDismissed(true);
    if (idRef.current) writeHelperDismissed(idRef.current);
  }, []);

  // --- Visibility: re-read the document on every transaction ----------------------
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const input = { typeKey, doc: editor.state.doc, selection: editor.state.selection, tellMePhase: phase };
  // The form stays open over a typed document after "Try again".
  const visible = helperVisible({ dismissed, ...input }) || formOpen;
  const idle = phase === "idle";

  // Once the helper has shown, writing the first paragraph or choosing a type dismisses it for good.
  // An existing document that never showed it writes nothing.
  const seen = useRef(false);
  const shown = visible && idle;
  const done = shouldDismiss(input);
  useEffect(() => {
    if (shown) seen.current = true;
    if (done && seen.current && !dismissedRef.current) dismiss();
  }, [shown, done, dismiss]);

  // What renders: the tips wait while a panel covers the right of the text (drawer or sheet), and come back when it closes.
  const tips = visible && idle && !formOpen;
  const rendered = visible && !(tips && covered);
  useEffect(() => {
    onVisibleChange?.(rendered);
  }, [rendered, onVisibleChange]);
  useEffect(() => () => onVisibleChange?.(false), [onVisibleChange]);

  // --- The dog: "Hide Sasha's tips" while the tips show ---------------------------
  const setDog = useSetAtom(dogActionAtom);
  const dogActive = tips && !covered;
  useEffect(() => {
    if (!dogActive) return;
    setDog({
      label: "Hide Sasha's tips",
      run: () => {
        dismiss();
        // The dog stops being a button: put focus back in the document.
        requestAnimationFrame(() => editor.commands.focus());
      },
    });
    return () => setDog(null);
  }, [dogActive, dismiss, editor, setDog]);

  // --- Focus ---------------------------------------------------------------------
  const sectionRef = useRef<HTMLElement>(null);
  const tellMeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (formOpen) textareaRef.current?.focus();
  }, [formOpen]);

  // A new card replaces the control that had focus: keep focus in the helper (unless it is elsewhere, e.g. the editor or the gallery).
  useEffect(() => {
    if (idle) return;
    const active = document.activeElement;
    if (!active || active === document.body || sectionRef.current?.contains(active)) cardRef.current?.focus();
  }, [phase, idle]);

  /** After the card or form goes: the "tell me" link if the tips still show, else the document. */
  const refocus = useCallback(() => {
    requestAnimationFrame(() => {
      if (tellMeRef.current?.isConnected) tellMeRef.current.focus();
      else if (!editor.isDestroyed) editor.commands.focus();
    });
  }, [editor]);

  const closeForm = () => {
    setFormOpen(false);
    refocus();
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const prompt = draft.trim();
    if (prompt.length < TELL_ME_PROMPT_MIN) return;
    setFormOpen(false);
    void tellMe.start(prompt);
  };

  const onFormKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeForm();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      submit();
    }
  };

  const finish = () => {
    tellMe.reset();
    refocus();
  };
  // The run is one undo step (use-tell-me.ts): undo it and close the card. The
  // document stays typed, so the tips don't come back.
  const undoNote = phase === "done" ? tellMeUndoNote(state.done) : null;
  const undoRun = () => {
    tellMe.reset();
    editor.chain().focus().undo().run();
  };

  if (!rendered) return null;

  const style = { "--helper-left": `${leftEdge}px` } as CSSProperties;
  const typeName = tellMe.typeTitle ?? "the document";

  let body: ReactNode;
  if (formOpen && idle) {
    const length = draft.length;
    body = (
      <form onSubmit={submit} onKeyDown={onFormKeyDown} className={`${CARD} w-full`}>
        <label htmlFor="tell-me-prompt" className="mb-1.5 block font-semibold">
          What doc would you like to create?
        </label>
        <textarea
          ref={textareaRef}
          id="tell-me-prompt"
          rows={3}
          maxLength={TELL_ME_PROMPT_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby="tell-me-hint"
          placeholder="e.g. A progress report for the Hartley Foundation on our after-school reading program"
          className="block w-full resize-y rounded-lg border border-[var(--doc-field-line)] bg-transparent px-3 py-2 text-[15px] leading-snug text-[var(--doc-ink)] placeholder:text-[var(--doc-muted)] focus:border-[var(--action)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--action)]"
        />
        <p id="tell-me-hint" className="mt-1.5 text-[13px] leading-snug text-[var(--doc-muted)]">
          Sasha picks a document type, lays out its sections and drafts each one from this and your linked sources. Uses one draft per section.
          {length > COUNT_FROM && (
            <span className="ml-1 tabular-nums">
              {length} of {TELL_ME_PROMPT_MAX} characters.
            </span>
          )}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={draft.trim().length < TELL_ME_PROMPT_MIN} className={PRIMARY}>
            Create document
          </button>
          <button type="button" onClick={closeForm} className={SECONDARY}>
            Cancel
          </button>
          <span className="text-[13px] text-[var(--doc-muted)]" aria-hidden="true">
            {isMac() ? "⌘" : "Ctrl+"}↵ to create
          </span>
        </div>
      </form>
    );
  } else if (phase === "choosing") {
    body = (
      <div ref={cardRef} tabIndex={-1} className={CARD}>
        <p role="status" aria-live="polite" className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--action)] motion-reduce:animate-none" aria-hidden="true" />
          Choosing a document type…
        </p>
      </div>
    );
  } else if (phase === "drafting") {
    const { done: n, total, current } = state;
    body = (
      <div ref={cardRef} tabIndex={-1} className={`${CARD} w-full`}>
        <p role="status" aria-live="polite" className="flex items-center gap-2 font-medium">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--action)] motion-reduce:animate-none" aria-hidden="true" />
          {total ? `Drafting ${typeName}: ${n} of ${total} sections` : `Laying out the ${typeName} outline…`}
        </p>
        {total > 0 && (
          <div
            role="progressbar"
            aria-label="Sections drafted"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={n}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--doc-line)]"
          >
            <div className="h-full rounded-full bg-[var(--action)] transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round((n / total) * 100)}%` }} />
          </div>
        )}
        {current.length > 0 && <p className="mt-1.5 truncate text-[13px] text-[var(--doc-muted)]">Writing {current.map((h) => `“${h || "Untitled section"}”`).join(", ")}</p>}
        <div className="mt-2 flex items-center gap-3">
          {/* aria-disabled, not disabled: a focused button that turns disabled drops focus to <body>. */}
          <button
            type="button"
            onClick={() => {
              if (!state.cancelled) tellMe.cancel();
            }}
            aria-disabled={state.cancelled || undefined}
            className={`${SECONDARY} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          >
            Stop
          </button>
          {state.cancelled && <span className="text-[13px] text-[var(--doc-muted)]">Stopping after the sections being written…</span>}
        </div>
      </div>
    );
  } else if (phase === "needs_type") {
    body = (
      <div ref={cardRef} tabIndex={-1} className={CARD}>
        <p>Sasha couldn&apos;t tell which type fits. Choose one and Sasha will draft it.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onChooseType} className={PRIMARY}>
            Choose a type
          </button>
          <button type="button" onClick={finish} className={SECONDARY}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (phase === "done") {
    body = (
      <div ref={cardRef} tabIndex={-1} className={`${CARD} w-full`}>
        <p role="status" aria-live="polite">
          Drafted {state.done} of {state.total} section{state.total === 1 ? "" : "s"}. Your request is saved in Notes.
          {undoNote && <span className="mt-0.5 block text-[13px] text-[var(--doc-muted)]">{undoNote}</span>}
        </p>
        {state.errors.length > 0 && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-[var(--doc-muted)]">
            {state.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={finish} className={PRIMARY}>
            Done
          </button>
          {undoNote && (
            <button type="button" onClick={undoRun} className={SECONDARY}>
              Undo
            </button>
          )}
        </div>
      </div>
    );
  } else if (phase === "failed") {
    body = (
      <div ref={cardRef} tabIndex={-1} className={`${CARD} w-full`}>
        <p role="alert" className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {state.errors[0] ?? "Sasha couldn't start. Try again."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(state.prompt);
              tellMe.reset();
              setFormOpen(true);
            }}
            className={PRIMARY}
          >
            Try again
          </button>
          <button type="button" onClick={finish} className={SECONDARY}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <p className="text-[15px] leading-snug text-[var(--helper-ink)] sm:text-[19px]">
        Start writing,{" "}
        <button type="button" onClick={onUploadSources} className={LINK}>
          <UploadFileIcon className="mr-1 inline-block h-[1.1em] w-[1.1em] align-[-0.2em]" aria-hidden="true" />
          upload sources
        </button>
        , choose a{" "}
        <button type="button" onClick={onChooseType} className={LINK}>
          document type
          <CaretUpDown className="ml-1 inline-block h-[1em] w-[1em] align-[-0.15em]" aria-hidden="true" />
        </button>{" "}
        {/* The mockup's line break; on phones the text wraps where it must. */}
        <br className="hidden sm:inline" />
        or just{" "}
        <button ref={tellMeRef} type="button" onClick={() => setFormOpen(true)} className={LINK}>
          tell me
        </button>{" "}
        what doc you&apos;d like to create…
      </p>
    );
  }

  // The section spans from just past the editor's left edge to the floating
  // buttons, so its content wraps short of them whatever their width
  // (--fab-width, published by floating-actions.tsx). The tips share the
  // buttons' line; a card (the form, progress, results) is taller and sits above
  // them (--fab-clearance). It is under the drawer and sheet (z-18), and only
  // its content takes pointer events, so the text beside it stays clickable.
  const place = tips
    ? "bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-[calc(var(--fab-width,0px)+1.5rem)] sm:right-[calc(var(--fab-width,0px)+2rem)]"
    : "bottom-[calc(max(1.25rem,var(--fab-clearance,0px))+env(safe-area-inset-bottom,0px))] right-4 sm:right-8";
  return (
    <section
      ref={sectionRef}
      aria-label="Getting started"
      style={style}
      className={`pointer-events-none fixed left-[calc(var(--helper-left)+16px)] z-[17] flex flex-col items-start sm:left-[calc(var(--helper-left)+48px)] [&>*]:pointer-events-auto [&>*]:max-w-[34rem] ${place}`}
    >
      {body}
    </section>
  );
}
