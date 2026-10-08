"use client";

// The Sources dialog, opened from the floating Sources button: the document's
// linked sources and the ways to add more, i.e. the Sources panel without its
// panel header. Radix traps focus while it is open; closing puts focus back
// on the button that opened it.

import type { RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SourcesPanel } from "./sources-panel";

export function SourcesModal({
  open,
  onOpenChange,
  documentId,
  documentTitle,
  ensureSaved,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string | null;
  documentTitle: string;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** The button that opened the dialog; focus goes back to it on close. */
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-[var(--doc-surface)] p-0 text-[var(--doc-ink)] sm:max-w-2xl"
        onCloseAutoFocus={(e) => {
          const button = returnFocusRef?.current;
          if (button) {
            e.preventDefault();
            button.focus();
          }
        }}
      >
        <DialogHeader className="px-6 pb-3 pt-6 text-left">
          <DialogTitle className="text-xl">Sources</DialogTitle>
          <DialogDescription className="sr-only">Files, links and notes this document is written from.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Mounted only while open, so it loads fresh each time and stops polling when closed. */}
          {open && <SourcesPanel bare documentId={documentId} documentTitle={documentTitle} ensureSaved={ensureSaved} onClose={() => onOpenChange(false)} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
