"use client";

// The editor card's top row (redesign3-spec.md §10): the round back button to
// the documents overview on the left, the document title with its type icon in
// the centre (an editable field; the page's sr-only <h1> lives here too), and
// "Share & Export" on the right.
//
// From lg the grid's side columns share the leftover width equally, so a short
// title sits in the middle of the card as in the mockup whatever the two
// buttons measure. Narrower, two equal sides left too little room for the title
// beside the full Share & Export label (they overlapped at 800px), so there the
// title's column takes whatever the buttons leave. The sides never shrink below
// their button (a plain 1fr let a long title run under Share & Export). Either
// way a long title scrolls inside the field (it shows an ellipsis while not
// focused). Below md Share & Export is its icon alone.
//
// CONTRACT (redesign 3 foundation): props fixed; the editor-chrome track owns
// the implementation, the editor-panels track renders it in document-screen.

import Link from "next/link";
import type { RefObject } from "react";
import { ChevronLeft, ShareExportArrowIcon } from "@/components/icons";
import { TypeIcon } from "@/components/type-icon";
import type { DocumentTypeSummary } from "@/catalog/schema";

export type EditorHeaderProps = {
  title: string;
  onTitleChange: (title: string) => void;
  /** The document's type (its icon and colour beside the title); null when untyped. */
  type: DocumentTypeSummary | null;
  shareOpen: boolean;
  onShare: () => void;
  /** Focus returns here when the Share & Export dialog closes. */
  shareButtonRef: RefObject<HTMLButtonElement | null>;
};

const FOCUS_RING = "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]";

export function EditorHeader({ title, onTitleChange, type, shareOpen, onShare, shareButtonRef }: EditorHeaderProps) {
  return (
    <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-4 pt-4 sm:gap-x-4 sm:px-12 sm:pt-10 lg:grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)]">
      <Link
        href="/"
        aria-label="Back to documents"
        className={`grid h-12 w-12 place-items-center justify-self-start rounded-full bg-[var(--back-bg)] text-[var(--action)] transition-colors hover:bg-[var(--action-soft)] motion-reduce:transition-none ${FOCUS_RING}`}
      >
        <ChevronLeft className="h-6 w-6" aria-hidden />
      </Link>
      <div className="flex min-w-0 items-center justify-center gap-2 sm:gap-3">
        <h1 className="sr-only">{title.trim() || "Untitled document"}</h1>
        <TypeIcon icon={type?.icon} color={type?.color} className="h-7 w-7 sm:h-9 sm:w-9" />
        <label htmlFor="doc-title" className="sr-only">
          Document title
        </label>
        <input
          id="doc-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Untitled document"
          style={{ fieldSizing: "content" } as React.CSSProperties}
          className="min-w-[6ch] max-w-full text-ellipsis rounded-md bg-transparent text-center text-[24px] font-medium tracking-tight text-[var(--ink)] outline-none placeholder:text-[var(--doc-muted)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--action)] sm:min-w-[10ch] sm:text-[40px]"
        />
      </div>
      <button
        ref={shareButtonRef}
        type="button"
        onClick={onShare}
        aria-haspopup="dialog"
        aria-expanded={shareOpen}
        className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 justify-self-end whitespace-nowrap rounded-xl px-2 text-[18px] font-medium text-[var(--action)] transition-colors hover:bg-[var(--action-soft)] aria-expanded:bg-[var(--action-soft)] motion-reduce:transition-none sm:min-h-9 ${FOCUS_RING}`}
      >
        <ShareExportArrowIcon className="h-6 w-6 shrink-0" aria-hidden />
        {/* Two copies rather than sr-only/not-sr-only: not-sr-only resets
            white-space, so the label wrapped onto three lines under the title
            at 640px. Below md the button is its icon alone. */}
        <span className="hidden md:inline">Share &amp; Export</span>
        <span className="sr-only md:hidden">Share &amp; Export</span>
      </button>
    </header>
  );
}
