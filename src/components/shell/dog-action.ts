"use client";

// What clicking Sasha (the dog at the bottom of the app rail) does, if
// anything. The editing screen's empty-state helper sets it while the helper
// shows ("Hide the writing tips"); the rail then renders the dog as a button
// (redesign2-spec.md §5.3). Null leaves the dog decorative. The frame lives in
// the root layout, so the rail can't take this as a prop from the page.

import { atom } from "jotai";

export type DogAction = {
  /** The button's accessible name, e.g. "Hide Sasha's tips". */
  label: string;
  run: () => void;
};

export const dogActionAtom = atom<DogAction | null>(null);
