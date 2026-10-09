"use client";

// The document modal (PLAN §6.2), opened from the floating Sources button (on
// Sources) or the Notes control beside the title (on Notes): one dialog with a
// tab per pane. Each pane mounts only while its tab is active, so it loads
// fresh and stops polling when hidden. Radix traps focus while it is open;
// closing puts focus back on the control that opened it.
//
// Owned by the notes-and-modal track (phase4-spec.md §2). The Suggestions pane
// and the Sources panel's prefill belong to the suggestions track; the Data
// tab (phase5-spec.md §5) to the data-ui track; the Workflows tab
// (phase6-spec.md §8.1) to the workflows-ui track. "Add" on a suggestion hands
// over to Sources or Data with a prefill; a workflow's evidence and missing
// inputs hand over to Sources, focused on the source when there is one.
// Phase 8: the Sources tab offers "Learn a type from these examples" (the
// learn track), preselecting the linked sources that have finished reading.

import { useEffect, useRef, useState, type RefObject } from "react";
import { Sparkles } from "@/components/icons";
import { LearnDialog } from "@/components/learn/learn-dialog";
import type { LearnExampleRef } from "@/lib/learn/contract";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LinkedSource } from "@/components/sources/shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TableSnapshot } from "@/lib/data/contract";
import type { DataPrefill, SourcePrefill } from "@/lib/suggestions/contract";
import type { ProposedChange } from "@/lib/workflow/contract";
import type { AppliedChange } from "./apply-workflow-change";
import { DataPane } from "./data-pane";
import { DOCUMENT_MODAL_TABS, escapeAction, modalTitle, TAB_LABELS, type DocumentModalTab } from "./document-modal-model";
import { NotesPane, type NotesPaneHandle } from "./notes-pane";
import { SourcesPanel } from "./sources-panel";
import { SuggestionsPane } from "./suggestions-pane";
import type { SaveStatus } from "./use-document";
import { WorkflowsPane, type WorkflowsView } from "./workflows-pane";
import type { CheckpointDraft, WorkflowsPrefill } from "./workflows-pane-model";

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
  onInsertTable,
  onApplyWorkflowChange,
  onJumpToSection,
  workflowsPrefill = null,
  onWorkflowsPrefillDone,
  onLearnedType,
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
  /** The Data tab's "Insert table": put the snapshot at the editor's cursor. */
  onInsertTable?: (snapshot: TableSnapshot) => void;
  /** The Workflows tab's "Apply to document": the editor makes the change as one undo step (apply-workflow-change.ts). */
  onApplyWorkflowChange?: (change: ProposedChange) => Promise<AppliedChange>;
  /** A finding's location: close the dialog and scroll the editor to the section. */
  onJumpToSection?: (sectionId: string) => void;
  /** Opened from the classifier chip's "Restructure…": that workflow with its target type chosen. */
  workflowsPrefill?: WorkflowsPrefill | null;
  onWorkflowsPrefillDone?: () => void;
  /** After "Learn a type from these examples" saves: use the new type for this document (the editor sets type_key). */
  onLearnedType?: (typeKey: string) => void;
}) {
  const open = tab !== null;
  // "Add" on a source suggestion hands over to the Sources tab with this.
  const [prefill, setPrefill] = useState<SourcePrefill | null>(null);
  // "Add" on a data suggestion hands over to the Data tab with this.
  const [dataPrefill, setDataPrefill] = useState<DataPrefill | null>(null);
  // "Open in Sources" from a workflow finding: the source to expand.
  const [sourceFocus, setSourceFocus] = useState<string | null>(null);
  // The Workflows tab's open run and half-filled checkpoint drafts. The pane
  // unmounts with its tab (and with the dialog, on a jump to a section), so they
  // live here: checking a finding's passage and coming back finds both as they
  // were. Unlike the hand-overs they outlast a close, but not the document.
  const [workflowsView, setWorkflowsView] = useState<WorkflowsView>({ kind: "list" });
  const [checkpointDrafts, setCheckpointDrafts] = useState<Record<string, CheckpointDraft>>({});
  // The Sources tab's linked sources, for "Learn a type from these examples".
  const [linked, setLinked] = useState<LinkedSource[]>([]);
  const [learnOpen, setLearnOpen] = useState(false);
  const learnPreselect: LearnExampleRef[] = linked.filter((s) => s.extraction_status === "ready" || s.extraction_status === "partial").map((s) => ({ kind: "source", sourceId: s.id }));
  const [workflowsDoc, setWorkflowsDoc] = useState(documentId);
  if (workflowsDoc !== documentId) {
    setWorkflowsDoc(documentId);
    // A first save gives a new document its id: what was open is still this document's.
    if (workflowsDoc !== null) {
      setWorkflowsView({ kind: "list" });
      setCheckpointDrafts({});
    }
  }
  // The parent can close the dialog without close() ("Insert table" does): the
  // hand-overs still end with it, so they don't come back the next time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setPrefill(null);
      setDataPrefill(null);
      setSourceFocus(null);
    }
  }
  // The pill row scrolls sideways on a phone: keep the open tab in view (Workflows sits past the edge).
  const tabRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tab) return;
    const raf = requestAnimationFrame(() => tabRow.current?.querySelector<HTMLElement>('[data-state="active"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    return () => cancelAnimationFrame(raf);
  }, [tab]);
  // The Notes pane, so Esc can cancel its dictation. Closing (or switching tabs)
  // unmounts the pane, which keeps a running dictation's words.
  const notesPane = useRef<NotesPaneHandle>(null);
  // Closed by "Insert table": focus goes to the editor (document-screen), not back to the opener.
  const inserted = useRef(false);
  const insertTable = onInsertTable
    ? (snapshot: TableSnapshot) => {
        inserted.current = true;
        onInsertTable(snapshot);
      }
    : undefined;
  const close = () => {
    setPrefill(null);
    setDataPrefill(null);
    setSourceFocus(null);
    onTabChange(null);
  };
  // Closed by a workflow (a change applied, a jump to a section): focus goes to the editor, as after an insert.
  const closeToEditor = () => {
    inserted.current = true;
    close();
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
          if (inserted.current) {
            inserted.current = false;
            e.preventDefault();
            return;
          }
          const button = returnFocusRef?.current;
          if (button?.isConnected) {
            e.preventDefault();
            button.focus();
          }
        }}
      >
        <DialogHeader className="px-4 pb-3 pr-12 pt-5 text-left sm:px-6 sm:pr-14 sm:pt-6">
          <DialogTitle className="truncate text-xl font-semibold tracking-tight">{modalTitle(documentTitle)}</DialogTitle>
          <DialogDescription className="sr-only">Notes, sources, data, suggestions and workflows for this document.</DialogDescription>
        </DialogHeader>
        {tab && (
          <Tabs value={tab} onValueChange={(v) => onTabChange(v as DocumentModalTab)} className="flex min-h-0 flex-1 flex-col gap-0">
            {/* Quiet pills (mockup), scrolling sideways on a narrow phone rather than widening the page. */}
            <div ref={tabRow} className="mb-3 shrink-0 overflow-x-auto px-4 sm:px-6">
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
              {tab === "sources" && documentId && (
                <div className="mb-2 flex shrink-0 justify-end px-4 sm:px-6">
                  <button
                    type="button"
                    onClick={() => setLearnOpen(true)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)] sm:min-h-8"
                  >
                    <Sparkles className="h-4 w-4" /> Learn a type from these examples
                  </button>
                </div>
              )}
              {tab === "sources" && (
                <SourcesPanel
                  bare
                  documentId={documentId}
                  documentTitle={documentTitle}
                  ensureSaved={ensureSaved}
                  onClose={close}
                  prefill={prefill}
                  onPrefillDone={() => setPrefill(null)}
                  onSourcesChange={(sources) => {
                    setLinked(sources);
                    onSourcesChange?.(sources);
                  }}
                  onShowData={() => onTabChange("data")}
                  focusSourceId={sourceFocus}
                />
              )}
            </TabsContent>
            <TabsContent value="data" className="flex min-h-0 min-w-0 flex-col">
              {tab === "data" && (
                <DataPane
                  documentId={documentId}
                  ensureSaved={ensureSaved}
                  onInsertTable={insertTable}
                  prefill={dataPrefill}
                  onPrefillDone={() => setDataPrefill(null)}
                  onGoToSources={() => onTabChange("sources")}
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
                  onAddData={(p) => {
                    setDataPrefill(p);
                    onTabChange("data");
                  }}
                />
              )}
            </TabsContent>
            <TabsContent value="workflows" className="flex min-h-0 min-w-0 flex-col">
              {tab === "workflows" && (
                <WorkflowsPane
                  documentId={documentId}
                  typeKey={typeKey}
                  ensureSaved={ensureSaved}
                  prefill={workflowsPrefill}
                  onPrefillDone={onWorkflowsPrefillDone}
                  onApplyChange={onApplyWorkflowChange}
                  onChangeApplied={closeToEditor}
                  onJumpToSection={
                    onJumpToSection
                      ? (sectionId) => {
                          closeToEditor();
                          onJumpToSection(sectionId);
                        }
                      : undefined
                  }
                  onOpenSources={(sourceId) => {
                    setSourceFocus(sourceId);
                    onTabChange("sources");
                  }}
                  view={workflowsView}
                  onViewChange={setWorkflowsView}
                  checkpointDrafts={checkpointDrafts}
                  onCheckpointDraft={(key, draft) =>
                    setCheckpointDrafts((all) => {
                      const rest = { ...all };
                      delete rest[key];
                      return draft ? { ...rest, [key]: draft } : rest;
                    })
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
      <LearnDialog
        open={learnOpen}
        onOpenChange={setLearnOpen}
        linkedSources={linked}
        currentDocument={documentId ? { id: documentId, title: documentTitle } : null}
        preselect={learnPreselect.length ? learnPreselect : documentId ? [{ kind: "document", documentId }] : []}
        documentId={documentId}
        onUseType={onLearnedType}
      />
    </Dialog>
  );
}
