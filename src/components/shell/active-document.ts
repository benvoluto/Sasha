"use client";

// The document open in the editor, as the app frame sees it. The editing
// screen (src/components/editor/document-screen.tsx) writes it while it is
// mounted (id becomes set after the first save; title follows every keystroke)
// and clears it on unmount; the documents panel reads it for the "Active" row
// and the live title. The frame lives in the root layout, so it can't take
// these as props from the page.

import { atom } from "jotai";

export type ActiveDocument = { id: string | null; title: string };

export const activeDocumentAtom = atom<ActiveDocument | null>(null);
