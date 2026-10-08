"use client";

// The client side of the document-type classifier (PLAN §6.3, decision 10):
// watches the editor body and the notes, decides when to call
// POST /api/documents/[id]/classify (src/lib/classifier/trigger.ts, pure),
// and turns the stored result into the chip's suggestion (chipSuggestion).
//
// Runs wait for the autosave (the server reads the stored text), happen at
// most every CLASSIFY_MIN_INTERVAL_MS, and are background work: network errors
// stay silent and never become a notice.
//
// Session baselines (phase4-spec.md §3.3): when the classifier view first
// loads, the content baseline is the body as it is (or nothing, for a document
// with no stored result, so one that already has enough words is eligible at
// once) and the drift baseline is the body as it is. Both reset after each run
// that judged the text (not after a failed attempt); the drift baseline also
// resets when the type changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { DocumentTypeSummary } from "@/catalog/schema";
import { chipSuggestion } from "@/lib/classifier/chip";
import {
  CLASSIFY_IDLE_MS,
  CLASSIFY_MIN_INTERVAL_MS,
  type ChipSuggestion,
  type ClassifierView,
  type ClassifyRateLimited,
  type ClassifyResponse,
  type TypeSource,
  type WordBag,
} from "@/lib/classifier/contract";
import { bagDistance, resetsBaselines, shouldClassify, startsFresh, wordBag, wordCount } from "@/lib/classifier/trigger";
import type { SaveStatus } from "./use-document";

export type ClassifierInput = {
  editor: Editor | null;
  documentId: string | null;
  typeKey: string | null;
  typeSource: TypeSource | null;
  notes: string;
  /** Enabled types (titles for the chip; candidates outside the list are ignored). */
  types: DocumentTypeSummary[];
  /** Runs wait for a saved document: the server reads the stored text. */
  saveStatus: SaveStatus;
};

export type ClassifierHandle = {
  /** What the chip shows, or null. */
  suggestion: ChipSuggestion | null;
  /** "Not now": counts towards CLASSIFY_MAX_DISMISSALS for the type and hides the chip. */
  dismiss: (key: string) => Promise<void>;
};

/** Never look again sooner than this. */
const MIN_CHECK_MS = 1000;

const EMPTY_BAG: WordBag = new Map();

type Session = {
  /** The document these baselines belong to. */
  documentId: string;
  contentBaseline: WordBag;
  driftBaseline: WordBag;
  driftWords: number;
  notesAtLastRun: string;
  lastContentEditAt: number | null;
  lastNotesEditAt: number | null;
  /** Local runs (and failed attempts), ms epoch. */
  lastLocalRunAt: number | null;
};

const classifyUrl = (id: string) => `/api/documents/${encodeURIComponent(id)}/classify`;

export function useClassifier(input: ClassifierInput): ClassifierHandle {
  const { editor, documentId, typeKey, typeSource, notes, types, saveStatus } = input;
  const [view, setView] = useState<ClassifierView | null>(null);
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(() => new Set());

  const latest = useRef({ editor, documentId, typeKey, typeSource, notes, saveStatus, view });
  latest.current = { editor, documentId, typeKey, typeSource, notes, saveStatus, view };
  const session = useRef<Session | null>(null);
  const running = useRef(false);
  const timer = useRef<number | null>(null);
  /** The latest check (set below), for timers. */
  const evaluateRef = useRef<() => void>(() => {});
  /** The body's bag, recomputed only when the body changed since the last read. */
  const body = useRef<{ dirty: boolean; bag: WordBag; words: number }>({ dirty: true, bag: EMPTY_BAG, words: 0 });

  const readBody = useCallback(() => {
    const ed = latest.current.editor;
    if (body.current.dirty && ed && !ed.isDestroyed) {
      const text = ed.getText({ blockSeparator: "\n" });
      body.current = { dirty: false, bag: wordBag(text), words: wordCount(text) };
    }
    return body.current;
  }, []);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const schedule = useCallback((ms: number) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      evaluateRef.current();
    }, Math.max(MIN_CHECK_MS, ms));
  }, []);

  const resetBaselines = useCallback((s: Session, notesAtRun: string, bag: WordBag, words: number) => {
    s.contentBaseline = bag;
    s.driftBaseline = bag;
    s.driftWords = words;
    s.notesAtLastRun = notesAtRun;
  }, []);

  const run = useCallback(
    async (trigger: "content" | "notes" | "drift") => {
      const s = session.current;
      const id = latest.current.documentId;
      if (!s || !id || s.documentId !== id) return;
      const { bag, words } = readBody();
      const notesAtRun = latest.current.notes;
      running.current = true;
      s.lastLocalRunAt = Date.now();
      try {
        const res = await fetch(classifyUrl(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger }) });
        const out = (await res.json().catch(() => null)) as (ClassifyResponse | ClassifyRateLimited) | null;
        if (session.current !== s) return;
        if (res.status === 429 && out && "retryAfterMs" in out) {
          // The server ran recently: line the local gate up with it.
          s.lastLocalRunAt = Date.now() - CLASSIFY_MIN_INTERVAL_MS + out.retryAfterMs;
          if (out.view) setView(out.view);
          return;
        }
        if (!res.ok || !out || !("ran" in out) || !out.view) return;
        // Always adopt the view (a failed run's last_classified_at drives the 2-minute retry),
        // but only move the baselines when the server actually judged this text.
        setView(out.view);
        if (resetsBaselines(out)) resetBaselines(s, notesAtRun, bag, words);
      } catch {
        // Background work: stay quiet; the local gate holds the next try off for a while.
      } finally {
        running.current = false;
        if (session.current === s) schedule(MIN_CHECK_MS);
      }
    },
    [readBody, resetBaselines, schedule],
  );

  const evaluate = useCallback(() => {
    const cur = latest.current;
    const s = session.current;
    if (!s || !cur.documentId || s.documentId !== cur.documentId || !cur.view) return;
    if (cur.saveStatus !== "saved" && cur.saveStatus !== "idle") return; // the save-status effect looks again
    const now = Date.now();
    const { bag, words } = readBody();
    const serverRunAt = cur.view.last_classified_at ? Date.parse(cur.view.last_classified_at) : null;
    const lastRunAt = Math.max(serverRunAt ?? -Infinity, s.lastLocalRunAt ?? -Infinity);
    const decision = shouldClassify({
      now,
      lastContentEditAt: s.lastContentEditAt,
      lastNotesEditAt: s.lastNotesEditAt,
      contentWordsChanged: bagDistance(bag, s.contentBaseline),
      notesChanged: cur.notes.trim() !== s.notesAtLastRun.trim(),
      totalWords: words + wordCount(cur.notes),
      lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
      running: running.current,
      typeKey: cur.typeKey,
      typeSource: cur.typeSource,
      baselineWords: s.driftWords,
      wordsChangedSinceBaseline: bagDistance(bag, s.driftBaseline),
    });
    if (decision.run) void run(decision.trigger);
    else if (decision.retryInMs !== undefined) schedule(decision.retryInMs);
  }, [readBody, run, schedule]);
  evaluateRef.current = evaluate;

  // A document (or a new one's first id): load its view and start a session.
  useEffect(() => {
    session.current = null;
    setView(null);
    setLocallyDismissed(new Set());
    clearTimer();
    if (!documentId) return;
    const controller = new AbortController();
    fetch(classifyUrl(documentId), { cache: "no-store", signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ view?: ClassifierView }>) : null))
      .then((out) => {
        if (!out?.view || latest.current.documentId !== documentId) return;
        body.current.dirty = true;
        const { bag, words } = readBody();
        const fresh = startsFresh(out.view);
        session.current = {
          documentId,
          contentBaseline: fresh ? EMPTY_BAG : bag,
          driftBaseline: bag,
          driftWords: words,
          notesAtLastRun: fresh ? "" : latest.current.notes,
          lastContentEditAt: null,
          lastNotesEditAt: null,
          lastLocalRunAt: null,
        };
        setView(out.view);
        schedule(MIN_CHECK_MS);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [documentId, readBody, schedule]);

  // A new type: the drift baseline restarts, and the stored view is reloaded.
  const prevType = useRef(typeKey);
  useEffect(() => {
    if (prevType.current === typeKey) return;
    prevType.current = typeKey;
    const s = session.current;
    if (!s || !documentId) return;
    body.current.dirty = true;
    const { bag, words } = readBody();
    s.driftBaseline = bag;
    s.driftWords = words;
    fetch(classifyUrl(documentId), { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ view?: ClassifierView }>) : null))
      .then((out) => {
        if (out?.view && session.current === s) setView(out.view);
      })
      .catch(() => {});
  }, [typeKey, documentId, readBody]);

  // Body edits: mark the text stale (read on the next check, not per keystroke) and look again once idle.
  useEffect(() => {
    if (!editor) return;
    body.current.dirty = true;
    const onUpdate = () => {
      body.current.dirty = true;
      if (session.current) {
        session.current.lastContentEditAt = Date.now();
        schedule(CLASSIFY_IDLE_MS);
      }
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, schedule]);

  // Notes edits.
  const prevNotes = useRef(notes);
  useEffect(() => {
    if (prevNotes.current === notes) return;
    prevNotes.current = notes;
    if (session.current) {
      session.current.lastNotesEditAt = Date.now();
      schedule(CLASSIFY_IDLE_MS);
    }
  }, [notes, schedule]);

  // A save landed (or the document is idle again): the stored text is current, look now.
  useEffect(() => {
    if (saveStatus === "saved" || saveStatus === "idle") schedule(MIN_CHECK_MS);
  }, [saveStatus, schedule]);

  useEffect(() => clearTimer, []);

  const dismiss = useCallback(async (key: string) => {
    setLocallyDismissed((prev) => new Set(prev).add(key));
    const id = latest.current.documentId;
    if (!id) return;
    try {
      const res = await fetch(`${classifyUrl(id)}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
      const out = (await res.json().catch(() => null)) as { view?: ClassifierView } | null;
      if (res.ok && out?.view && latest.current.documentId === id) setView(out.view);
    } catch {
      // Background: the local dismissal still hides the chip for this session.
    }
  }, []);

  const titles = useMemo(() => new Map(types.map((t) => [t.key, t.title])), [types]);
  const suggestion = useMemo(
    () => (view && documentId ? chipSuggestion({ state: view.state, typeKey, typeSource, titles, locallyDismissed }) : null),
    [view, documentId, typeKey, typeSource, titles, locallyDismissed],
  );

  return { suggestion, dismiss };
}
