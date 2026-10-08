"use client";

// App-frame state that must outlive a page: whether the documents panel is
// open (a jotai atom, since the frame sits in the root layout and the panel
// should stay open while moving between documents), the remembered preference
// for it across reloads, and the breakpoint that switches the panel between
// pushing the page aside and floating over it.

import { atom } from "jotai";
import { useSyncExternalStore } from "react";

export const docsPanelOpenAtom = atom(false);

const STORAGE_KEY = "sasha.docsPanel";

/** The remembered open/closed choice, or null when there is none or storage is unavailable. */
export function readDocsPanelPref(): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "open" ? true : raw === "closed" ? false : null;
  } catch {
    return null;
  }
}

export function writeDocsPanelPref(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // Private windows and blocked storage: the panel just won't be remembered.
  }
}

/** Where the panel stops floating over the page and pushes it aside instead. */
export const PUSH_QUERY = "(min-width: 1024px)";

function subscribeWide(onChange: () => void): () => void {
  const mql = window.matchMedia(PUSH_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** True at ≥1024px (push mode). False on the server and before hydration, which renders the closed-overlay form. */
export function useIsWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(PUSH_QUERY).matches,
    () => false,
  );
}
