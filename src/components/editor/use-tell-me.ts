"use client";

// "Tell me what doc you'd like to create": the empty editor's prompt-to-
// document flow (redesign2-spec.md §6). Picks a type from the prompt
// (start-from-prompt route), records the prompt in the document notes, lays
// out the type's outline, drafts each draftable section from the prompt and
// the linked sources (section generate route, TELL_ME_CONCURRENCY at a time),
// and applies the result as one undo step after a version snapshot. The pure
// parts (targets, the pool, the swap) are in use-tell-me-model.ts.

import { Node as PMNodeClass } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useCallback, useRef, useState } from "react";
import { outlineDoc } from "@/catalog/outline";
import type { DocumentTypeSummary } from "@/catalog/schema";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import {
  IDLE_TELL_ME,
  notesWithPrompt,
  TELL_ME_CONCURRENCY,
  TELL_ME_PROMPT_MAX,
  TELL_ME_PROMPT_MIN,
  type StartFromPromptResponse,
  type TellMeState,
} from "@/lib/tell-me/contract";
import { newSectionId, setBusySections } from "./extensions";
import { sectionBodyRange } from "./tracked-range";
import { findType } from "./type-picker";
import type { useDocument } from "./use-document";
import { draftSection, finalPhase, replaceDocTr, runDraftPool, tellMeTargets } from "./use-tell-me-model";

export type UseTellMeOptions = {
  editor: Editor | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** use-document's change: the flow sets type_key / type_source "user", notes and (when empty) title. */
  change: ReturnType<typeof useDocument>["change"];
  /** The document's current title and notes. */
  title: string;
  notes: string;
  /** The team's enabled types (useDocumentTypes). */
  types: DocumentTypeSummary[];
  /** POST /versions with a reason (document-screen's snapshot). */
  snapshot: (reason: string) => Promise<void>;
  /** No type fitted the prompt: open the Document Gallery; choosing a type there calls continueWithType. */
  onNeedType: () => void;
};

export type TellMe = {
  state: TellMeState;
  /** The title of the type being drafted (for the progress line), or null before one is chosen. */
  typeTitle: string | null;
  /** Run the flow for this prompt. Resolves when it has finished, failed or been stopped. */
  start: (prompt: string) => Promise<void>;
  /** After "needs_type": go on with the type the person chose in the gallery. */
  continueWithType: (type: DocumentTypeSummary) => Promise<void>;
  /** Stop: running sections finish and are applied, no new ones start. */
  cancel: () => void;
  /** Back to idle (after done / failed, or when the gallery is closed without a choice in "needs_type"). */
  reset: () => void;
};

const SAVE_FAILED = "Couldn't save the document, so Sasha can't start. Try again.";

/** Why other changes to the document wait while "tell me" drafts it (panels, gallery, workflow apply, table insert). */
export const TELL_ME_LOCK = "Sasha is drafting the document. Wait for it to finish or press Stop.";

/** The same while "tell me" is still choosing the type: its outline will replace the document. */
export const TELL_ME_CHOOSING_LOCK = "Sasha is choosing a document type for your request. Wait for it to finish.";

export function useTellMe(options: UseTellMeOptions): TellMe {
  // The latest options, read after each await (title, notes and types change while a run waits).
  const opts = useRef(options);
  opts.current = options;
  const [state, setStateRaw] = useState<TellMeState>(IDLE_TELL_ME);
  const stateRef = useRef(state);
  const setState = useCallback((next: TellMeState | ((s: TellMeState) => TellMeState)) => {
    stateRef.current = typeof next === "function" ? next(stateRef.current) : next;
    setStateRaw(stateRef.current);
  }, []);
  // Bumped by start and reset, so a reply for a run that was reset is ignored.
  const runId = useRef(0);
  const cancelled = useRef(false);
  // The model's title while the person picks a type ("needs_type").
  const pendingTitle = useRef<string | null>(null);
  const [typeTitle, setTypeTitle] = useState<string | null>(null);

  const fail = useCallback((prompt: string, error: string) => setState({ ...IDLE_TELL_ME, phase: "failed", prompt, errors: [error] }), [setState]);

  const run = useCallback(
    async (t: DocumentTypeSummary, prompt: string, title: string | null) => {
      const { editor, change, notes, title: currentTitle, snapshot, ensureSaved } = opts.current;
      if (!editor || editor.isDestroyed) return fail(prompt, "The editor isn't ready. Try again.");
      cancelled.current = false;
      setTypeTitle(t.title);
      setState((s) => ({ ...s, phase: "drafting", prompt, done: 0, total: 0, current: [], errors: [], cancelled: false }));
      change({ type_key: t.key, type_source: "user", notes: notesWithPrompt(notes, prompt), ...(title && !currentTitle.trim() ? { title } : {}) });
      await snapshot(`Before “tell me”: ${prompt.slice(0, 60)}`);
      if (editor.isDestroyed) return;

      const before = editor.getJSON();
      editor.setEditable(false);
      const errors: string[] = [];
      let done = 0;
      let total = 0;
      let firstSection: string | null = null;
      try {
        // The outline, as one step outside the history (the swap below makes the undo step).
        editor.view.dispatch(replaceDocTr(editor.state, outlineDoc(t.sections, newSectionId), false));
        // The stored document must have the type and the headings: the generate route reads its neighbours there.
        const id = await ensureSaved();
        const targets = id ? tellMeTargets(editor.state.doc, t.sections) : [];
        if (!id) errors.push(SAVE_FAILED);
        total = targets.length;
        firstSection = targets[0]?.sectionId ?? null;
        setState((s) => ({ ...s, total, errors: [...errors] }));
        const busy = new Set(targets.map((x) => x.sectionId));
        if (!editor.isDestroyed) setBusySections(editor.view, busy, "tell-me");

        await runDraftPool({
          items: targets,
          concurrency: TELL_ME_CONCURRENCY,
          stopped: () => cancelled.current || editor.isDestroyed,
          draft: (target) => draftSection(fetch, id!, target, prompt),
          onStart: (target) => setState((s) => ({ ...s, current: [...s.current, target.heading] })),
          onResult: (target, outcome) => {
            if (editor.isDestroyed) return;
            busy.delete(target.sectionId);
            if (outcome.kind === "ok") {
              const range = sectionBodyRange(editor.state.doc, target.sectionId);
              if (range) {
                const blocks = sectionBlocksFromMarkdown(outcome.markdown, range.level, { lineBreaks: outcome.lineBreaks, citations: outcome.citations });
                const nodes = blocks.map((b) => PMNodeClass.fromJSON(editor.schema, b));
                editor.view.dispatch(editor.state.tr.replaceWith(range.from, range.to, nodes).setMeta("addToHistory", false));
                done++;
              } else {
                errors.push(`“${target.heading.trim() || "Untitled section"}”: the section was removed, so its draft wasn't added.`);
              }
            } else {
              errors.push(outcome.error);
            }
            setBusySections(editor.view, busy, "tell-me");
            setState((s) => {
              const i = s.current.indexOf(target.heading);
              return { ...s, done, errors: [...errors], current: i < 0 ? s.current : [...s.current.slice(0, i), ...s.current.slice(i + 1)] };
            });
          },
        });

        if (editor.isDestroyed) return;
        // One undo step: back to the document before, out of the history, then everything as one step in it.
        const final = editor.getJSON();
        editor.view.dispatch(replaceDocTr(editor.state, before, false));
        editor.view.dispatch(replaceDocTr(editor.state, final, true));
      } catch (error) {
        console.error("[tell-me] failed:", error);
        errors.push("Something went wrong while drafting. Try again.");
      } finally {
        if (!editor.isDestroyed) {
          setBusySections(editor.view, [], "tell-me");
          editor.setEditable(true);
          // The caret at the end of the first drafted section, ready to read on or edit.
          const range = firstSection ? sectionBodyRange(editor.state.doc, firstSection) : null;
          if (range) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(Math.max(range.from, range.to - 1)), -1)).scrollIntoView());
          editor.commands.focus();
        }
      }
      if (editor.isDestroyed) return;

      // The helper's result card says what was drafted and offers Undo (a
      // notice as well would cover the card with the same words).
      setState((s) => ({ ...s, phase: finalPhase(done, errors), done, total, current: [], errors: [...errors] }));
    },
    [fail, setState],
  );

  const start = useCallback(
    async (raw: string) => {
      const prompt = raw.trim();
      const phase = stateRef.current.phase;
      if (phase === "choosing" || phase === "drafting") return;
      if (prompt.length < TELL_ME_PROMPT_MIN) return fail(prompt, "Say a little more about the document.");
      if (prompt.length > TELL_ME_PROMPT_MAX) return fail(prompt, `Keep the request under ${TELL_ME_PROMPT_MAX} characters.`);
      const mine = ++runId.current;
      pendingTitle.current = null;
      setState({ ...IDLE_TELL_ME, phase: "choosing", prompt });
      // The outline will replace the document: nothing typed while the type is chosen may be lost under it.
      const editor = opts.current.editor;
      if (editor && !editor.isDestroyed) editor.setEditable(false);
      try {
        const id = await opts.current.ensureSaved();
        if (mine !== runId.current) return;
        if (!id) return fail(prompt, SAVE_FAILED);
        let res: Response;
        try {
          res = await fetch(`/api/documents/${id}/start-from-prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
        } catch {
          if (mine === runId.current) fail(prompt, "Couldn't reach the server. Check your connection and try again.");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as Partial<StartFromPromptResponse> & { error?: unknown };
        if (mine !== runId.current) return;
        if (!res.ok) return fail(prompt, typeof body.error === "string" && body.error ? body.error : "Sasha couldn't start. Try again.");

        const t = findType(opts.current.types, body.typeKey ?? null);
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
        if (!t) {
          pendingTitle.current = title;
          setState({ ...IDLE_TELL_ME, phase: "needs_type", prompt });
          opts.current.onNeedType();
          return;
        }
        await run(t, prompt, title);
      } finally {
        // run() hands editing back when it finishes; a failure or "needs_type" gets it back here (reset does it itself,
        // and a newer run owns the editor now).
        if (mine === runId.current && editor && !editor.isDestroyed && stateRef.current.phase !== "drafting") editor.setEditable(true);
      }
    },
    [fail, run, setState],
  );

  const continueWithType = useCallback(
    async (t: DocumentTypeSummary) => {
      const s = stateRef.current;
      if (s.phase !== "needs_type") return;
      await run(t, s.prompt, pendingTitle.current);
    },
    [run],
  );

  const cancel = useCallback(() => {
    cancelled.current = true;
    if (stateRef.current.phase === "drafting") setState((s) => ({ ...s, cancelled: true }));
  }, [setState]);

  const reset = useCallback(() => {
    // A drafting run can't be dropped halfway (the document is mid-swap): Stop it instead.
    if (stateRef.current.phase === "drafting") return;
    runId.current++;
    pendingTitle.current = null;
    setTypeTitle(null);
    // Reset while the type was being chosen: the editor was read-only for it.
    const editor = opts.current.editor;
    if (stateRef.current.phase === "choosing" && editor && !editor.isDestroyed) editor.setEditable(true);
    setState(IDLE_TELL_ME);
  }, [setState]);

  return { state, typeTitle, start, continueWithType, cancel, reset };
}
