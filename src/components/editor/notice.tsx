"use client";

// The editing screen's notices: short messages at the bottom of the screen
// with up to two actions (Undo, Replace anyway / Discard). A notice without
// `sticky` goes away by itself after a few seconds, and a newer one replaces
// it. A sticky notice is a decision the person still has to make (a draft that
// came back after its section changed holds Claude's result in its actions),
// so nothing replaces it: sticky notices stack above the passing one until each
// is acted on or dismissed.
//
// They sit at the bottom centre of the space right of Sasha (DOG_WIDTH), and on
// phones above the editor's row of panel buttons (right-column.tsx).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "@/components/icons";
import { DOG_WIDTH } from "@/components/shell/dog";

export type NoticeAction = { label: string; run: () => void };

export type Notice = {
  text: string;
  tone?: "error";
  actions?: NoticeAction[];
  /** Stays until acted on or dismissed (a decision the person has to make). */
  sticky?: boolean;
  /** A sticky notice with the same key replaces the earlier one (a newer result for the same section). */
  key?: string;
};

/** Shows a notice; null clears the passing (non-sticky) one, never a pending decision. */
export type Notify = (notice: Notice | null) => void;

export type ShownNotice = Notice & { id: number };

export type NoticeState = {
  /** Sticky notices waiting on the person, oldest first. */
  decisions: ShownNotice[];
  /** The latest passing notice. */
  passing: ShownNotice | null;
};

export const NO_NOTICES: NoticeState = { decisions: [], passing: null };

export function pushNotice(state: NoticeState, notice: Notice | null, id: number): NoticeState {
  if (!notice) return state.passing ? { ...state, passing: null } : state;
  if (!notice.sticky) return { ...state, passing: { ...notice, id } };
  const rest = notice.key ? state.decisions.filter((d) => d.key !== notice.key) : state.decisions;
  return { ...state, decisions: [...rest, { ...notice, id }] };
}

export function dismissNotice(state: NoticeState, id: number): NoticeState {
  if (state.passing?.id === id) return { ...state, passing: null };
  const decisions = state.decisions.filter((d) => d.id !== id);
  return decisions.length === state.decisions.length ? state : { ...state, decisions };
}

/** The screen's notices, with `notify` to pass to whatever shows one. */
export function useNotices() {
  const [state, setState] = useState<NoticeState>(NO_NOTICES);
  const notify = useCallback<Notify>((notice) => {
    const id = nextNoticeId++;
    setState((s) => pushNotice(s, notice, id));
  }, []);
  const dismiss = useCallback((id: number) => setState((s) => dismissNotice(s, id)), []);
  return { notices: state, notify, dismiss };
}

let nextNoticeId = 1;

/** Pending decisions, then the passing notice, stacked at the bottom of the screen. */
export function NoticeStack({ notices, onDismiss }: { notices: NoticeState; onDismiss: (id: number) => void }) {
  const shown = [...notices.decisions, ...(notices.passing ? [notices.passing] : [])];
  if (!shown.length) return null;
  return (
    <div
      style={{ "--dog-w": `${DOG_WIDTH}px` } as CSSProperties}
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-50 flex flex-col items-center gap-2 px-4 sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom,0px))] sm:left-[var(--dog-w)] [&>*]:pointer-events-auto"
    >
      {shown.map((n) => (
        <NoticeToast key={n.id} notice={n} onDismiss={() => onDismiss(n.id)} />
      ))}
    </div>
  );
}

function NoticeToast({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  // The stack passes a fresh callback each render; the timer runs once per notice.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!notice || notice.sticky) return;
    const t = window.setTimeout(() => dismissRef.current(), notice.tone === "error" ? 12_000 : 8000);
    return () => window.clearTimeout(t);
  }, [notice]);

  if (!notice) return null;
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`flex max-w-full items-center gap-3 rounded-full px-4 py-2 text-sm shadow-lg ${
        notice.tone === "error" ? "bg-red-700 text-white dark:bg-red-800" : "bg-[var(--doc-ink)] text-[var(--doc-bg)]"
      }`}
    >
      <span className="min-w-0">{notice.text}</span>
      {notice.actions?.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => {
            onDismiss();
            a.run();
          }}
          className="shrink-0 font-semibold underline underline-offset-2"
        >
          {a.label}
        </button>
      ))}
      {(notice.sticky || notice.tone === "error") && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-mr-1 shrink-0 rounded-full p-1 opacity-80 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
