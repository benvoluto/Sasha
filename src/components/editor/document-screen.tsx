"use client";

// The editing screen (redesign3-spec.md §10–15): a white card on the cream
// page (EditorFrame) with Sasha beside it (the app shell's Dog). The header
// has the back button, the type icon and title, and Share & Export; then a
// sticky formatting toolbar ending in the save status; the document; and the
// right column (right-column.tsx): the Sources pill, which opens the document
// modal (Notes / Sources / Data / Suggestions / Workflows), then the Agents
// and Outline cards, each a button until opened. The empty-state helper sits
// beside Sasha. Each heading has a gutter button that opens the section's
// actions (draft, rewrite, notes). Changes a workflow run proposes are applied
// here, in the editor, as one undo step (apply-workflow-change.ts). The deep
// links ?notes=1 and ?run=<id> open the modal on Notes or on that run.

import { EditorContent, useEditor } from "@tiptap/react";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { Loader2 } from "@/components/icons";
import type { LinkedSource } from "@/components/sources/shared";
import { outlineDoc } from "@/catalog/outline";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { TableSnapshot } from "@/lib/data/contract";
import { tableSnapshotNodes } from "@/lib/data/snapshot";
import { OPEN_NOTES_PARAM, OPEN_RUN_PARAM } from "@/lib/documents/card-text";
import type { PMNode } from "@/lib/documents/sections";
import type { SaveOutlineAsTypeResponse, SectionListResponse } from "@/lib/sections/contract";
import type { ProposedChange } from "@/lib/workflow/contract";
import { applyRestructurePlan } from "@/lib/workflow/restructure";
import { applyOutlineMerge } from "./apply-outline";
import { applyWorkflowChange, type AppliedChange } from "./apply-workflow-change";
import { CheckPanel, type CheckTarget } from "./check-panel";
import { CitationLayer } from "./citation-layer";
import { suggestionAnnouncement } from "./classifier-chip";
import { DocumentGalleryDialog } from "./document-gallery-dialog";
import { DocumentModal } from "./document-modal";
import { deepLinkOpen, type DocumentModalTab } from "./document-modal-model";
import { EditorFrame } from "./editor-frame";
import { EditorHeader } from "./editor-header";
import { EditorToolbar } from "./editor-toolbar";
import { documentExtensions, newSectionId, sectionIdsOnLoad } from "./extensions";
import { NoticeStack, useNotices, type Notice } from "./notice";
import { goToHeading, OUTLINE_TYPE_SELECT_ID, OutlinePanel } from "./outline-panel";
import { SectionMenu, type SectionMenuTarget } from "./section-menu";
import { SectionNotesPanel, useCaretSectionId } from "./section-notes-panel";
import { RightColumn } from "./right-column";
import {
  browserStorage,
  CLOSED_COLUMN,
  columnCloseFocus,
  columnReducer,
  openFocusId,
  overlaysText,
  panelsOf,
  readPanels,
  rightColumnMode,
  writePanels,
  type ColumnAction,
  type ColumnSlot,
  type RightColumnMode,
} from "./right-column-model";
import { EmptyHelper } from "./empty-helper";
import { SaveStatus } from "./save-status";
import { ToolsPanel } from "./side-panels";
import { sectionBodyRange } from "./tracked-range";
import { ShareExportDialog } from "./share-export-dialog";
import { findType, SaveOutlineDialog, useDocumentTypes } from "./type-picker";
import { useClassifier } from "./use-classifier";
import { useDocument, type SaveStatus as SaveStatusValue } from "./use-document";
import { useOutlineStatus } from "./use-outline-status";
import { TELL_ME_CHOOSING_LOCK, TELL_ME_LOCK, useTellMe } from "./use-tell-me";
import { busyAnnouncement, useSectionGeneration } from "./use-section-generation";
import { linkedSourcesKey, useSuggestionsRefresh } from "./use-suggestions-refresh";
import type { WorkflowsView } from "./workflows-pane";
import { chipApplyAction, restructurePrefill, type WorkflowsPrefill } from "./workflows-pane-model";

export function DocumentScreen({ documentId }: { documentId: string | null }) {
  const { doc, loading, notFound, status, error, conflict, change, flush, isSaved, resolveConflict } = useDocument(documentId);
  const catalog = useDocumentTypes();

  if (notFound) {
    return (
      <EditorFrame>
        <div className="mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold">Document not found</h1>
          <p className="mt-2 text-[var(--doc-muted)]">It may have been deleted, or it belongs to a team you are not signed in to.</p>
          <Link
            href="/"
            className="mt-6 inline-flex min-h-11 items-center rounded-full bg-[var(--action)] px-5 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] sm:min-h-9 dark:text-[var(--editor-bg)]"
          >
            Back to documents
          </Link>
        </div>
      </EditorFrame>
    );
  }

  return (
    <EditorFrame>
      {loading || !(doc.content_json || !documentId) ? (
        <div className="flex items-center justify-center gap-2 py-32 text-[var(--doc-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" /> Opening document…
        </div>
      ) : (
        <Workspace
          key={documentId ?? "new"}
          initial={doc.content_json}
          doc={doc}
          catalog={catalog}
          status={status}
          error={error}
          conflict={!!conflict}
          change={change}
          flush={flush}
          isSaved={isSaved}
          resolveConflict={resolveConflict}
        />
      )}
    </EditorFrame>
  );
}

type WorkspaceProps = {
  initial: PMNode | null;
  doc: ReturnType<typeof useDocument>["doc"];
  catalog: ReturnType<typeof useDocumentTypes>;
  status: SaveStatusValue;
  error: string | null;
  conflict: boolean;
  change: ReturnType<typeof useDocument>["change"];
  flush: ReturnType<typeof useDocument>["flush"];
  isSaved: ReturnType<typeof useDocument>["isSaved"];
  resolveConflict: ReturnType<typeof useDocument>["resolveConflict"];
};

/**
 * Where the right column goes (rightColumnMode), from the body row's width and
 * the viewport's. Also publishes the sticky toolbar's height as --toolbar-h on
 * the row, so the in-flow column sticks just under it, and --column-top (the
 * row's top, never above the toolbar) for the column's height and the drawer's
 * top.
 */
function useColumnLayout(rowRef: RefObject<HTMLDivElement | null>, toolbarRef: RefObject<HTMLDivElement | null>) {
  const [mode, setMode] = useState<RightColumnMode>("inline");
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // --column-top: where the sticky column's top is right now (below the
    // header until the page scrolls, then under the toolbar), so its height
    // ends at the viewport's bottom and its last controls stay reachable.
    let toolbar = 0;
    const placeTop = () => {
      const top = Math.max(toolbar, Math.round(row.getBoundingClientRect().top));
      row.style.setProperty("--column-top", `${top}px`);
    };
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        placeTop();
      });
    };
    const measure = () => {
      toolbar = Math.round(toolbarRef.current?.getBoundingClientRect().height ?? 0);
      row.style.setProperty("--toolbar-h", `${toolbar}px`);
      placeTop();
      setMode(rightColumnMode(row.getBoundingClientRect().width, window.innerWidth));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    if (toolbarRef.current) ro.observe(toolbarRef.current);
    // The header and banners above the row move it without resizing it.
    for (let el = row.previousElementSibling; el; el = el.previousElementSibling) ro.observe(el);
    if (row.parentElement) ro.observe(row.parentElement);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(frame);
    };
  }, [rowRef, toolbarRef]);
  return mode;
}

/** The section notes saved for each section of the document (for the outline's notes marker). */
function useSectionNotes(documentId: string | null) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!documentId || loaded.current === documentId) return;
    loaded.current = documentId;
    fetch(`/api/documents/${encodeURIComponent(documentId)}/sections`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SectionListResponse>) : null))
      .then((b) => {
        if (b?.sections) setNotes((prev) => ({ ...Object.fromEntries(b.sections.map((s) => [s.section_id, s.notes])), ...prev }));
      })
      .catch(() => {});
  }, [documentId]);
  const update = useCallback((sectionId: string, text: string) => setNotes((prev) => ({ ...prev, [sectionId]: text })), []);
  return { notes, update };
}

function Workspace({ initial, doc, catalog, status, error, conflict, change, flush, isSaved, resolveConflict }: WorkspaceProps) {
  const types = catalog.types;
  const currentType = findType(types, doc.type_key);
  // The right column: Agents (or Section notes, or Check) above the outline (right-column-model.ts).
  const [column, dispatchColumn] = useReducer(columnReducer, CLOSED_COLUMN);
  const columnRef = useRef(column);
  columnRef.current = column;
  // The document modal (Notes / Sources / Data / Suggestions / Workflows), and the control that opened it.
  const [modalTab, setModalTab] = useState<DocumentModalTab | null>(null);
  // "upload sources" from the helper: the Sources tab opens on its upload area.
  const [sourcesMode, setSourcesMode] = useState<"upload" | null>(null);
  // A workflow that needs a form (the restructure workflow from the type change, or one picked in Agents): the Workflows tab opens on it.
  const [workflowsPrefill, setWorkflowsPrefill] = useState<WorkflowsPrefill | null>(null);
  // "Open run" in Agents and the ?run= deep link: the Workflows tab opens on that run.
  const [workflowsView, setWorkflowsView] = useState<WorkflowsView | null>(null);
  // The run started from the Agents card's picker; kept here so its progress outlasts the card closing.
  const [agentRun, setAgentRun] = useState<string | null>(null);
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  // The Outline card's "See all" pill: the Doc Gallery's focus goes back to it.
  const seeAllRef = useRef<HTMLButtonElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  // Focus goes back here when the modal closes, else to the Sources pill (DocumentModal openerRef).
  const modalOpenerRef = useRef<HTMLElement | null>(null);
  const openModal = (tab: DocumentModalTab, opener: Element | null = document.activeElement, mode: "upload" | null = null) => {
    modalOpenerRef.current = opener instanceof HTMLElement ? opener : null;
    setSourcesMode(mode);
    setModalTab(tab);
  };
  const outlineButtonRef = useRef<HTMLButtonElement>(null);
  const agentsButtonRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const columnMode = useColumnLayout(rowRef, toolbarRef);
  // Passing notices replace each other; a pending decision (a sticky notice) stays until it is made.
  const { notices, notify, dismiss: dismissNotice } = useNotices();
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const undoNotice = useCallback((text: string): Notice => ({ text, actions: [{ label: "Undo", run: () => editorRef.current?.chain().focus().undo().run() }] }), []);
  const [menu, setMenu] = useState<SectionMenuTarget | null>(null);
  /** The rubric Check panel's subject (the whole document, or a section from its gutter menu). */
  const [checkTarget, setCheckTarget] = useState<CheckTarget | null>(null);
  /** The Doc Gallery (the Outline card's "See all", tell-me's onNeedType). */
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [saveTypeOpen, setSaveTypeOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const docIdRef = useRef(doc.id);
  docIdRef.current = doc.id;
  const titleRef = useRef(doc.title);
  titleRef.current = doc.title;

  const snapshot = useCallback(async (reason: string) => {
    const id = docIdRef.current;
    if (!id) return;
    await fetch(`/api/documents/${id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }).catch(() => {});
  }, []);

  const extensions = useMemo(
    () =>
      documentExtensions({
        onDeleteSection: (heading) => {
          void snapshot(`Before deleting section “${heading}”`);
          notify(undoNotice(`Deleted “${heading || "Untitled section"}”.`));
        },
        onSectionMenu: (sectionId, anchor) => setMenu({ sectionId, anchor }),
      }),
    [snapshot, undoNotice, notify],
  );

  const editor = useEditor({
    extensions,
    content: initial ?? undefined,
    immediatelyRender: false,
    autofocus: initial ? false : "end",
    // A contenteditable div has no implicit role, and aria-label is prohibited on
    // a role-less div (axe aria-prohibited-attr), so name it as a multi-line textbox.
    editorProps: { attributes: { class: "doc-prose", role: "textbox", "aria-multiline": "true", "aria-label": "Document" } },
    onCreate: ({ editor: e }) => {
      // Headings saved without ids get them now (and the change is saved), so the caret has a section from the start.
      const tr = sectionIdsOnLoad(e.state);
      if (tr) e.view.dispatch(tr);
    },
    onUpdate: ({ editor: e }) => change({ content_json: e.getJSON() as PMNode }),
  });
  editorRef.current = editor;

  const ensureSaved = useCallback(async () => {
    // A blank new document has nothing pending, so flush alone wouldn't create
    // it; record its title as a change so the save goes out.
    if (!docIdRef.current) change({ title: titleRef.current });
    // The id comes from the save itself: docIdRef only updates when this
    // component re-renders, which happens after the save resolves.
    return (await flush()) || null;
  }, [change, flush]);

  /** Save now and say whether the stored document holds every edit (a workflow run is about to read it). */
  const saveDocument = useCallback(async () => {
    await ensureSaved();
    return isSaved();
  }, [ensureSaved, isSaved]);

  // The empty-state helper (empty-helper.tsx) and its "tell me" flow (use-tell-me.ts).
  const tellMe = useTellMe({
    editor,
    ensureSaved,
    change,
    title: doc.title,
    notes: doc.notes,
    types,
    snapshot,
    onNeedType: () => setGalleryOpen(true),
  });
  // While "tell me" chooses a type and drafts, nothing else may change the
  // document: its outline replaces the whole document, its result is one undo
  // step, and a second run on one of its sections would race it. The toolbar
  // and the panels show why.
  const drafting = tellMe.state.phase === "choosing" || tellMe.state.phase === "drafting";
  const lockReason = tellMe.state.phase === "choosing" ? TELL_ME_CHOOSING_LOCK : drafting ? TELL_ME_LOCK : null;
  const lockedNotice = useCallback(() => notify({ text: lockReason ?? TELL_ME_LOCK }), [notify, lockReason]);

  const generation = useSectionGeneration({ editor, ensureSaved, notify, locked: lockReason });
  const outlineStatus = useOutlineStatus({ documentId: doc.id, typeKey: currentType?.key ?? doc.type_key, saveStatus: status });
  const sectionNotes = useSectionNotes(doc.id);
  const caretSection = useCaretSectionId(editor);

  /** Set the type; with text already there, merge its outline in (apply-outline.ts). `source` is "classifier" from the suggestion. */
  const chooseType = async (t: DocumentTypeSummary | null, source: "user" | "classifier" = "user") => {
    if (drafting) return lockedNotice();
    change({ type_key: t?.key ?? null, type_source: source });
    if (!editor) return;
    if (!t) {
      editor.commands.focus();
      return;
    }
    if (editor.isEmpty) {
      editor.commands.setContent(outlineDoc(t.sections, newSectionId), true);
      // Caret at the end of the first heading, ready to write below it.
      const first = editor.state.doc.firstChild;
      editor.chain().focus().setTextSelection(first ? first.nodeSize + 1 : 1).run();
      notify(undoNotice(`Started from the ${t.title} outline.`));
      return;
    }
    await snapshot(`Before applying the ${t.title} outline`);
    const merged = applyOutlineMerge(editor, t, newSectionId);
    const where = merged.inOrder ? "in outline order" : "at the end";
    notify(
      merged.added || merged.tagged
        ? undoNotice(
            merged.added
              ? `Added ${merged.added} section${merged.added === 1 ? "" : "s"} from the ${t.title} outline ${where}.`
              : `Matched your headings to the ${t.title} outline.`,
          )
        : { text: `Your document already has every ${t.title} section.` },
    );
  };

  const classifier = useClassifier({
    editor,
    documentId: doc.id,
    typeKey: doc.type_key,
    typeSource: doc.type_source,
    notes: doc.notes,
    types,
    saveStatus: status,
  });
  // The linked sources as last reported by the Sources tab (null until it has loaded them).
  const [sourcesKey, setSourcesKey] = useState<string | null>(null);
  const onSourcesChange = useCallback((list: LinkedSource[]) => setSourcesKey(linkedSourcesKey(list)), []);
  useSuggestionsRefresh({ documentId: doc.id, typeKey: doc.type_key, notes: doc.notes, sources: sourcesKey });

  /** The Data tab's "Insert table": the snapshot and its citation at the cursor, then back to the document. */
  const insertTable = useCallback(
    (snap: TableSnapshot) => {
      const ed = editorRef.current;
      if (!ed) return;
      if (drafting) return lockedNotice();
      ed.chain().focus().insertContent(tableSnapshotNodes(snap, { rows: snap.rows.length, at: new Date().toISOString() })).run();
      setModalTab(null);
      // The dialog held focus until now (and leaves it alone after an insert): back to the text.
      requestAnimationFrame(() => editorRef.current?.commands.focus(null, { scrollIntoView: true }));
      notify(undoNotice("Table inserted."));
    },
    [notify, undoNotice, drafting, lockedNotice],
  );

  /** The Workflows tab's "Apply to document": the run's change as one undo step after a snapshot, then a notice (phase6-spec.md §8.2). */
  const applyChange = useCallback(
    async (proposed: ProposedChange): Promise<AppliedChange> => {
      const ed = editorRef.current;
      if (!ed) return { result: null, detail: "The editor isn't ready yet.", typeKey: null };
      if (lockReason) return { result: null, detail: lockReason, typeKey: null };
      const out = await applyWorkflowChange(ed, proposed, {
        ensureSaved,
        isSaved,
        snapshot,
        sectionsFor: (key) => findType(types, key)?.sections ?? null,
        newId: newSectionId,
        restructure: applyRestructurePlan,
      });
      if (out.typeKey) change({ type_key: out.typeKey, type_source: "restructure" });
      if (out.unsaved) notify({ text: `${proposed.title}: ${out.detail} The document hasn't saved yet.`, tone: "error" });
      else if (out.result === "applied") notify(undoNotice(`${proposed.title}: ${out.detail}`));
      else notify({ text: out.detail, tone: out.result === null ? "error" : undefined });
      return out;
    },
    [ensureSaved, isSaved, snapshot, types, change, notify, undoNotice, lockReason],
  );

  /** A workflow finding's location: the section's heading, in view. The dialog closes first. */
  const jumpToSection = useCallback((sectionId: string) => {
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      const s = ed ? sectionBodyRange(ed.state.doc, sectionId) : null;
      if (ed && s) goToHeading(ed, s.headingPos);
    });
  }, []);

  /**
   * The restructure workflow, to this type: the Outline card's "Restructure"
   * and its suggestion on a typed document, and the Doc Gallery's
   * "Restructure…". Focus comes back to the control that asked (the type
   * select), or to the "See all" pill when that was inside the closing gallery.
   */
  const openRestructure = (key: string) => {
    if (drafting) return lockedNotice();
    setWorkflowsPrefill(restructurePrefill(key));
    const active = document.activeElement;
    openModal("workflows", active && !active.closest('[role="dialog"]') ? active : (seeAllRef.current ?? document.getElementById(OUTLINE_TYPE_SELECT_ID)));
  };

  /** "Just set type": the type changes and the text stays as it is. */
  const justSetType = (t: DocumentTypeSummary) => {
    if (drafting) return lockedNotice();
    change({ type_key: t.key, type_source: "user" });
    notify({ text: `Type set to ${t.title}.` });
  };

  const saveOutlineAsType = async (title: string): Promise<string | null> => {
    // It sets the type and retags the headings, which "tell me" is rewriting.
    if (lockReason) return lockReason;
    const id = await ensureSaved();
    if (!id) return "Save the document first.";
    try {
      const res = await fetch("/api/document-types/from-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: id, title }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return typeof out.error === "string" ? out.error : `Couldn't save the type (${res.status}).`;
      const { type, specKeys } = out as SaveOutlineAsTypeResponse;
      await catalog.reload();
      change({ type_key: type.key });
      if (editor && !editor.isDestroyed) {
        // Tie the headings to the new type's sections, as one step outside the undo history.
        const tr = editor.state.tr;
        editor.state.doc.forEach((node, pos) => {
          const key = node.type.name === "heading" ? specKeys[String(node.attrs.sectionId)] : undefined;
          if (key && node.attrs.specKey !== key) tr.setNodeMarkup(pos, undefined, { ...node.attrs, specKey: key });
        });
        if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
      }
      notify({ text: `Saved as a team type: ${type.title}.` });
      return null;
    } catch {
      return "Couldn't reach the server. Try again.";
    }
  };

  const openCheckFor = (sectionId: string | null) => {
    const nonce = Date.now();
    setCheckTarget(sectionId ? { scope: "section", sectionId, nonce } : { scope: "document", nonce });
    dispatchColumn({ type: "check" });
  };

  const openNotesFor = (sectionId: string) => {
    if (editor) {
      const s = sectionBodyRange(editor.state.doc, sectionId);
      if (s) goToHeading(editor, s.headingPos);
    }
    dispatchColumn({ type: "notes" });
  };

  const setLink = () => {
    if (!editor) return;
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkDraft(prev || "https://");
  };
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  const [helperOn, setHelperOn] = useState(false);

  // The panels the person opens and closes are remembered for this document
  // (a new one has no id yet, so it isn't); restored once, as it opens, and
  // only where they sit beside the text: in the drawer or sheet they would
  // open over the document, modal, before the person has touched anything.
  const columnChange = (action: ColumnAction) => {
    dispatchColumn(action);
    writePanels(browserStorage(), docIdRef.current, panelsOf(columnReducer(columnRef.current, action)));
  };
  useEffect(() => {
    const row = rowRef.current;
    const stored = readPanels(browserStorage(), docIdRef.current);
    if (stored && row && rightColumnMode(row.getBoundingClientRect().width, window.innerWidth) === "inline") dispatchColumn({ type: "restore", panels: stored });
  }, []);

  // The deep links (redesign3-spec.md §1): ?notes=1 opens the modal on Notes,
  // ?run=<id> on that run in Workflows. Read once as the document opens, then
  // dropped from the address so a reload or Back doesn't open the dialog again.
  // With no opener, focus goes to the Sources pill when the dialog closes.
  useEffect(() => {
    const { open, strip } = deepLinkOpen(window.location.search, { notes: OPEN_NOTES_PARAM, run: OPEN_RUN_PARAM });
    if (open?.tab === "workflows") setWorkflowsView({ kind: "run", runId: open.runId, readOnly: false });
    if (open) openModal(open.tab, null);
    if (strip !== null) window.history.replaceState(window.history.state, "", `${window.location.pathname}${strip}${window.location.hash}`);
  }, []);

  /** Focus a stack button once it has rendered in place of its card, else the editor. */
  const focusButton = (which: "outline" | "agents") =>
    requestAnimationFrame(() => {
      const button = (which === "outline" ? outlineButtonRef : agentsButtonRef).current;
      if (button?.isConnected) button.focus();
      else editor?.commands.focus();
    });

  // A card closed from its own X unmounts the focused button: hand focus to the
  // button that now stands in its place (Agents for Section notes and Check too).
  const closeColumnPanel = (slot: ColumnSlot) => {
    columnChange({ type: "close", slot });
    focusButton(columnCloseFocus(slot));
  };

  // The button gives way to its card: move focus to the card's heading. `focusId` instead focuses a control in it.
  const openColumnPanel = (slot: ColumnSlot, focusId = openFocusId(slot)) => {
    columnChange({ type: "open", slot });
    requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  };

  const outlinePanel =
    column.outline && editor ? (
      <OutlinePanel
        editor={editor}
        type={currentType}
        typeKey={doc.type_key}
        types={types}
        status={outlineStatus.status}
        statusError={outlineStatus.error}
        notes={sectionNotes.notes}
        onClose={() => closeColumnPanel("outline")}
        currentSectionId={caretSection}
        locked={lockReason}
        onSeeAll={() => setGalleryOpen(true)}
        seeAllRef={seeAllRef}
        onApplyType={(t, source) => void chooseType(t, source)}
        onNoType={() => void chooseType(null)}
        onRestructure={openRestructure}
        onJustSetType={justSetType}
        suggestion={classifier.suggestion}
        onDismissSuggestion={(key) => void classifier.dismiss(key)}
      />
    ) : null;
  const lowerPanel = !editor ? null : column.lower === "agents" ? (
    <ToolsPanel
      editor={editor}
      documentId={doc.id}
      ensureSaved={ensureSaved}
      type={currentType}
      caretSectionId={caretSection}
      run={generation.run}
      busy={generation.busy}
      locked={lockReason}
      onClose={() => closeColumnPanel("lower")}
      onCheckDocument={() => openCheckFor(null)}
      onSectionNotes={() => caretSection && openNotesFor(caretSection)}
      runId={agentRun}
      onRunIdChange={setAgentRun}
      onWorkflowForm={(w) => {
        setWorkflowsPrefill({ workflowKey: w.key, targetType: null });
        openModal("workflows");
      }}
      onOpenRun={(runId) => {
        setWorkflowsView({ kind: "run", runId, readOnly: false });
        openModal("workflows");
      }}
    />
  ) : column.lower === "check" && checkTarget ? (
    <CheckPanel
      editor={editor}
      documentId={doc.id}
      target={checkTarget}
      ensureSaved={ensureSaved}
      run={generation.run}
      busy={generation.busy}
      onJumpToSection={jumpToSection}
      onClose={() => closeColumnPanel("lower")}
    />
  ) : column.lower === "notes" ? (
    <SectionNotesPanel
      editor={editor}
      documentId={doc.id}
      ensureSaved={ensureSaved}
      sectionId={caretSection}
      busy={generation.busy}
      run={generation.run}
      onSaved={sectionNotes.update}
      onClose={() => closeColumnPanel("lower")}
    />
  ) : null;

  return (
    <>
      <EditorHeader title={doc.title} onTitleChange={(title) => change({ title })} type={currentType} shareOpen={shareOpen} onShare={() => setShareOpen(true)} shareButtonRef={shareButtonRef} />
      {/* The classifier's suggestion waits in the Outline card and the Doc Gallery; say so when one arrives. */}
      <span role="status" aria-live="polite" className="sr-only">
        {suggestionAnnouncement(classifier.suggestion)}
      </span>

      {conflict && (
        <div role="alert" className="mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--alert-warn-line)] bg-[var(--alert-warn-bg)] px-4 py-3 text-sm text-[var(--alert-warn-ink)] sm:mx-12">
          <span className="flex-1">Someone else saved this document while you were editing. Your latest changes are not saved.</span>
          <button type="button" onClick={() => void resolveConflict("theirs").then(() => window.location.reload())} className="min-h-11 rounded-md border border-current px-3 py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--alert-warn-ink)] sm:min-h-8">
            Load their version
          </button>
          <button type="button" onClick={() => void resolveConflict("mine")} className="min-h-11 rounded-md bg-[var(--alert-warn-ink)] px-3 py-1 font-medium text-[var(--alert-warn-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--alert-warn-ink)] sm:min-h-8">
            Keep mine
          </button>
        </div>
      )}

      <div ref={toolbarRef} className="sticky top-0 z-[15] bg-[var(--editor-bg)]/95 backdrop-blur">
        {/* relative: the toolbar's sr-only and absolutely placed bits stay inside this scroller instead of widening the page. */}
        <div className="relative overflow-x-auto px-4 py-3 sm:px-12">
          {editor && <EditorToolbar editor={editor} onLink={setLink} locked={drafting} trailing={<SaveStatus status={status} error={error} isNew={!doc.id} savedAt={doc.updated_at} />} />}
        </div>
        {linkDraft !== null && editor && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const href = linkDraft.trim();
              if (!href || href === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
              else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
              setLinkDraft(null);
            }}
            data-inline-edit
            className="flex max-w-[52rem] flex-wrap items-center gap-2 px-5 pb-3 text-sm sm:px-12"
          >
            <label htmlFor="link-url">Link to</label>
            <input
              id="link-url"
              autoFocus
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                // Esc cancels the link form (and doesn't reach the panels or dialogs).
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setLinkDraft(null);
                  editor.commands.focus();
                }
              }}
              className="min-w-0 flex-1 rounded-md border border-[var(--doc-field-line)] bg-transparent px-2 py-1 outline-none focus:border-[var(--action)] focus-visible:ring-2 focus-visible:ring-[var(--action)]"
            />
            <button type="submit" className="rounded-md bg-[var(--action)] px-3 py-1 font-semibold text-white dark:text-[var(--editor-bg)]">
              Apply
            </button>
            <button type="button" onClick={() => setLinkDraft(null)} className="rounded-md px-2 py-1 text-[var(--doc-muted)] hover:text-[var(--ink)]">
              Cancel
            </button>
          </form>
        )}
      </div>

      {/* The column's placement is measured (useColumnLayout) rather than a CSS
          container query: a query container can become the containing block of
          the fixed drawer/sheet in some engines. */}
      <div ref={rowRef} className="flex min-h-[70vh]">
        <div className="min-w-0 flex-1 px-4 pb-32 pt-6 sm:px-12">
          <div className={`max-w-[64rem] ${helperOn ? "doc-helper-on" : ""}`}>
            <EditorContent editor={editor} />
            {editor && <CitationLayer editor={editor} documentId={doc.id || null} sourcesKey={sourcesKey} savedAt={doc.updated_at} />}
          </div>
        </div>
        <RightColumn
          mode={columnMode}
          lower={lowerPanel}
          outline={outlinePanel}
          onOpen={(slot) => openColumnPanel(slot)}
          onDismiss={() => {
            // Esc or the scrim in the drawer or sheet: back to the button of the card that was on top.
            const back = columnRef.current.lower ? "agents" : "outline";
            columnChange({ type: "close_all" });
            focusButton(back);
          }}
          onSources={() => openModal("sources", sourcesButtonRef.current)}
          sourcesOpen={modalTab !== null}
          sourcesRef={sourcesButtonRef}
          agentsRef={agentsButtonRef}
          outlineRef={outlineButtonRef}
        />
      </div>

      {editor && (
        <EmptyHelper
          editor={editor}
          documentId={doc.id || null}
          typeKey={doc.type_key}
          tellMe={tellMe}
          onUploadSources={() => openModal("sources", document.activeElement, "upload")}
          onChooseType={() => openColumnPanel("outline", OUTLINE_TYPE_SELECT_ID)}
          onOpenGallery={() => setGalleryOpen(true)}
          covered={overlaysText(columnMode, column)}
          onVisibleChange={setHelperOn}
        />
      )}
      <DocumentModal
        tab={modalTab}
        onTabChange={(t) => {
          setModalTab(t);
          // The suggestion's prefill lasts while the Workflows tab is showing.
          if (t !== "workflows") setWorkflowsPrefill(null);
          // The upload area opens once, when the helper asked for it.
          if (t !== "sources") setSourcesMode(null);
        }}
        documentId={doc.id || null}
        documentTitle={doc.title}
        typeKey={doc.type_key}
        notes={doc.notes}
        onNotesChange={(notes) => change({ notes })}
        saveStatus={status}
        saveError={error}
        ensureSaved={ensureSaved}
        returnFocusRef={sourcesButtonRef}
        openerRef={modalOpenerRef}
        sourcesMode={sourcesMode}
        onSourcesChange={onSourcesChange}
        onInsertTable={insertTable}
        onApplyWorkflowChange={applyChange}
        onSaveDocument={saveDocument}
        onJumpToSection={jumpToSection}
        workflowsPrefill={workflowsPrefill}
        onWorkflowsPrefillDone={() => setWorkflowsPrefill(null)}
        workflowsViewRequest={workflowsView}
        onLearnedType={async (key) => {
          // The type was just saved: load it into the picker before choosing it.
          await catalog.reload();
          if (lockReason) return lockedNotice();
          change({ type_key: key, type_source: "user" });
        }}
      />

      <span role="status" aria-live="polite" className="sr-only">
        {editor ? busyAnnouncement([...generation.busy].map((id) => sectionBodyRange(editor.state.doc, id)?.heading ?? "")) : ""}
      </span>

      {editor && (
        <SectionMenu
          editor={editor}
          target={menu}
          type={currentType}
          busy={generation.busy}
          onClose={() => setMenu(null)}
          onRun={(req) => {
            // The document is being drafted by tell me; a gutter run would race it.
            if (!drafting) void generation.run(req);
          }}
          onNotes={openNotesFor}
          onCheck={openCheckFor}
        />
      )}

      <DocumentGalleryDialog
        open={galleryOpen}
        onOpenChange={(o) => {
          setGalleryOpen(o);
          // Closed without a choice while "tell me" waits for a type: the flow ends.
          if (!o && tellMe.state.phase === "needs_type") tellMe.reset();
        }}
        types={types}
        loading={catalog.loading}
        error={catalog.error}
        typeKey={doc.type_key}
        current={currentType}
        returnFocusRef={seeAllRef}
        onFocusDocument={() => {
          // Back to the caret the choice left (chooseType's). Its focus() ran while the dialog's trap held
          // focus, so the browser caret is stale; an unchanged selection isn't redrawn, so step away and back.
          const ed = editorRef.current;
          if (!ed) return;
          const { from, to } = ed.state.selection;
          ed.view.focus();
          ed.commands.setTextSelection(0); // two dispatches: one chain would end where it began
          ed.commands.setTextSelection({ from, to });
        }}
        onChoose={async (t) => {
          if (tellMe.state.phase === "needs_type") {
            // "Tell me" found no type: go on drafting with the one chosen here.
            // Closed directly, so the flow isn't reset as a close without a choice.
            setGalleryOpen(false);
            await tellMe.continueWithType(t);
            return;
          }
          // "Tell me" is choosing or drafting: say so in the gallery rather than close it on nothing.
          if (lockReason) return lockReason;
          await chooseType(t);
          setGalleryOpen(false);
        }}
        onFreeform={() => void chooseType(null)}
        onSaveOutline={() => setSaveTypeOpen(true)}
        suggestion={classifier.suggestion}
        applyLabel={chipApplyAction(doc.type_key).restructure ? "Restructure?" : "Apply outline"}
        onApplySuggestion={(key) => {
          // A typed document (the drift case) restructures rather than only tagging headings.
          if (chipApplyAction(doc.type_key).restructure) return openRestructure(key);
          const t = findType(types, key);
          if (t) void chooseType(t, "classifier");
        }}
        onRestructure={openRestructure}
        onDismissSuggestion={(key) => void classifier.dismiss(key)}
      />
      <SaveOutlineDialog open={saveTypeOpen} onOpenChange={setSaveTypeOpen} defaultTitle={doc.title} onSave={saveOutlineAsType} returnFocusRef={seeAllRef} />
      <ShareExportDialog open={shareOpen} onOpenChange={setShareOpen} documentId={doc.id || null} title={doc.title} ensureSaved={ensureSaved} notify={notify} returnFocusRef={shareButtonRef} />

      <NoticeStack notices={notices} onDismiss={dismissNotice} />
    </>
  );
}
