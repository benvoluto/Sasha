"use client";

// The document modal (PLAN §6.2), opened from the floating Sources button (on
// Sources) or the Notes control beside the title (on Notes): one dialog with a
// tab per pane. Each pane mounts only while its tab is active, so it loads
// fresh and stops polling when hidden. Radix traps focus while it is open;
// closing puts focus back on the control that opened it.
//
// Owned by the notes-and-modal track (phase4-spec.md §2). The Suggestions pane
// and the Sources panel's prefill belong to the suggestions track.

import { useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LinkedSource } from "@/components/sources/shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SourcePrefill } from "@/lib/suggestions/contract";
import { DOCUMENT_MODAL_TABS, escapeAction, modalTitle, TAB_LABELS, type DocumentModalTab } from "./document-modal-model";
import { NotesPane, type NotesPaneHandle } from "./notes-pane";
import { SourcesPanel } from "./sources-panel";
import { SuggestionsPane } from "./suggestions-pane";
import type { SaveStatus } from "./use-document";

export function DocumentModal({
  tab,
  onTabChange,
  documentId,
  documentTitle,
  typeKey,
  notes,
  onNotesChange,
  saveStatus,
  saveError = null,
  ensureSaved,
  returnFocusRef,
  onSourcesChange,
}: {
  /** The open tab, or null when the dialog is closed. */
  tab: DocumentModalTab | null;
  onTabChange: (tab: DocumentModalTab | null) => void;
  documentId: string | null;
  documentTitle: string;
  typeKey: string | null;
  notes: string;
  /** Records a notes change in the document's save queue (use-document change({ notes })). */
  onNotesChange: (notes: string) => void;
  saveStatus: SaveStatus;
  /** The save error's text (use-document's error), shown in the Notes tab's status line. */
  saveError?: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** The control that opened the dialog; focus goes back to it on close. */
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  /** The Sources tab's linked sources whenever they load or change. */
  onSourcesChange?: (sources: LinkedSource[]) => void;
}) {
  const open = tab !== null;
  // "Add" on a source suggestion hands over to the Sources tab with this.
  const [prefill, setPrefill] = useState<SourcePrefill | null>(null);
  // The Notes pane, so Esc can cancel its dictation. Closing (or switching tabs)
  // unmounts the pane, which keeps a running dictation's words.
  const notesPane = useRef<NotesPaneHandle>(null);
  const close = () => {
    setPrefill(null);
    onTabChange(null);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onTabChange(tab ?? "sources") : close())}>
      <DialogContent
        className="flex h-[min(85dvh,46rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border-[var(--doc-line)] bg-[var(--doc-surface)] p-0 font-sans text-[var(--doc-ink)] sm:max-w-2xl"
        onEscapeKeyDown={(e) => {
          const pane = notesPane.current;
          if (escapeAction(!!pane?.dictating()) === "cancel_dictation") {
            e.preventDefault();
            pane?.cancelDictation();
          }
        }}
        onCloseAutoFocus={(e) => {
          const button = returnFocusRef?.current;
          if (button?.isConnected) {
            e.preventDefault();
            button.focus();
          }
        }}
      >
        <DialogHeader className="px-4 pb-3 pr-12 pt-5 text-left sm:px-6 sm:pr-14 sm:pt-6">
          <DialogTitle className="truncate text-xl font-semibold tracking-tight">{modalTitle(documentTitle)}</DialogTitle>
          <DialogDescription className="sr-only">Notes, sources and suggestions for this document.</DialogDescription>
        </DialogHeader>
        {tab && (
          <Tabs value={tab} onValueChange={(v) => onTabChange(v as DocumentModalTab)} className="flex min-h-0 flex-1 flex-col gap-0">
            {/* Quiet pills (mockup), scrolling sideways on a narrow phone rather than widening the page. */}
            <div className="mb-3 shrink-0 overflow-x-auto px-4 sm:px-6">
              <TabsList className="h-auto w-max gap-1.5 rounded-none bg-transparent p-0">
                {DOCUMENT_MODAL_TABS.map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="h-9 flex-none rounded-full border-0 px-4 text-[15px] font-medium text-[var(--doc-muted)] shadow-none transition-colors hover:bg-[var(--go-soft)] hover:text-[var(--go)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] focus-visible:ring-0 data-[state=active]:bg-[var(--go-soft-strong)] data-[state=active]:text-[var(--go)] data-[state=active]:shadow-none dark:text-[var(--doc-muted)] dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-[var(--go-soft-strong)] dark:data-[state=active]:text-[var(--go)]"
                  >
                    {TAB_LABELS[t]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="notes" className="flex min-h-0 min-w-0 flex-col">
              {tab === "notes" && <NotesPane controlRef={notesPane} notes={notes} onChange={onNotesChange} saveStatus={saveStatus} saveError={saveError} />}
            </TabsContent>
            <TabsContent value="sources" className="flex min-h-0 min-w-0 flex-col">
              {tab === "sources" && (
                <SourcesPanel
                  bare
                  documentId={documentId}
                  documentTitle={documentTitle}
                  ensureSaved={ensureSaved}
                  onClose={close}
                  prefill={prefill}
                  onPrefillDone={() => setPrefill(null)}
                  onSourcesChange={onSourcesChange}
                />
              )}
            </TabsContent>
            <TabsContent value="suggestions" className="flex min-h-0 min-w-0 flex-col">
              {tab === "suggestions" && (
                <SuggestionsPane
                  documentId={documentId}
                  typeKey={typeKey}
                  ensureSaved={ensureSaved}
                  onAddSource={(p) => {
                    setPrefill(p);
                    onTabChange("sources");
                  }}
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
