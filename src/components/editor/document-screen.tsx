"use client";

// The editing screen: the first thing a person sees, inside the app frame
// (rail and documents panel, src/components/shell). A header with the title,
// save status and three buttons (redesign2-spec.md §1): Sources opens the
// document modal (Notes / Sources / Data / Suggestions / Workflows), Document
// Gallery the type gallery with the classifier's suggestion, Share & Export the
// sharing and download dialog. Then a sticky formatting toolbar; the document
// on a plain white page; a right column of floating Tools and Outline cards
// (right-column.tsx) opened from the floating buttons; the empty-state helper
// beside Sasha. Each heading has a gutter button that opens the section's
// actions (draft, rewrite, notes). Changes a workflow run proposes are applied
// here, in the editor, as one undo step (apply-workflow-change.ts).

import { EditorContent, useEditor } from "@tiptap/react";
import { useSetAtom } from "jotai";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { GalleryIcon, HeaderSourcesIcon, Loader2, ShareExportIcon } from "@/components/icons";
import { activeDocumentAtom } from "@/components/shell/active-document";
import type { LinkedSource } from "@/components/sources/shared";
import { outlineDoc } from "@/catalog/outline";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { TableSnapshot } from "@/lib/data/contract";
import { tableSnapshotNodes } from "@/lib/data/snapshot";
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
import type { DocumentModalTab } from "./document-modal-model";
import { EditorToolbar } from "./editor-toolbar";
import { documentExtensions, newSectionId, sectionIdsOnLoad } from "./extensions";
import { FloatingActions } from "./floating-actions";
import { NoticeStack, useNotices, type Notice } from "./notice";
import { goToHeading, OutlinePanel } from "./outline-panel";
import { SectionMenu, type SectionMenuTarget } from "./section-menu";
import { SectionNotesPanel, useCaretSectionId } from "./section-notes-panel";
import { RightColumn } from "./right-column";
import {
  CLOSED_COLUMN,
  closeLower,
  closeOutline,
  columnCloseFocus,
  isColumnOpen,
  openCheck,
  openNotes,
  openOutline,
  openTools,
  OUTLINE_SLOT_ID,
  rightColumnMode,
  TOOLS_SLOT_ID,
  type ColumnSlot,
  type RightColumnMode,
  type RightColumnState,
} from "./right-column-model";
import { EmptyHelper } from "./empty-helper";
import { ToolsPanel } from "./side-panels";
import { sectionBodyRange } from "./tracked-range";
import { ShareExportDialog } from "./share-export-dialog";
import { findType, SaveOutlineDialog, useDocumentTypes } from "./type-picker";
import { useClassifier } from "./use-classifier";
import { useDocument, type SaveStatus } from "./use-document";
import { useOutlineStatus } from "./use-outline-status";
import { TELL_ME_CHOOSING_LOCK, TELL_ME_LOCK, useTellMe } from "./use-tell-me";
import { busyAnnouncement, useSectionGeneration } from "./use-section-generation";
import { linkedSourcesKey, useSuggestionsRefresh } from "./use-suggestions-refresh";
import { chipApplyAction, restructurePrefill, type WorkflowsPrefill } from "./workflows-pane-model";

/**
 * One of the header's three green buttons: icon and label once the header is
 * wide enough for all three labels and a title (a container query on the
 * header, so an open documents panel counts too), else only the 44px icon (the
 * label stays its name).
 */
function HeaderButton({
  ref,
  label,
  icon: Icon,
  expanded,
  onClick,
  dot = false,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** Its dialog is open. */
  expanded: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** A suggestion is waiting (the Document Gallery's classifier suggestion). */
  dot?: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      // A hover name for when the header is too narrow for the labels.
      title={label}
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center gap-2.5 rounded-xl px-2 text-[18px] font-medium text-[var(--go)] hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] aria-expanded:bg-[var(--go-soft)] sm:min-h-9 sm:px-2.5"
    >
      <Icon className="h-7 w-7 shrink-0" aria-hidden />
      <span className="sr-only @min-[60rem]:not-sr-only">{label}</span>
      {dot && (
        <>
          <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--go)]" />
          <span className="sr-only">, suggestion ready</span>
        </>
      )}
    </button>
  );
}

function StatusText({ status, error, isNew }: { status: SaveStatus; error: string | null; isNew: boolean }) {
  const text =
    status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? (error ?? "Not saved") : status === "conflict" ? "Not saved" : isNew ? "Not saved yet" : "";
  return (
    <span role="status" aria-live="polite" className={`text-xs ${status === "error" || status === "conflict" ? "text-[var(--alert-danger-ink)]" : "text-[var(--doc-muted)]"}`}>
      {status === "saving" && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
      {text}
    </span>
  );
}

export function DocumentScreen({ documentId }: { documentId: string | null }) {
  const { doc, loading, notFound, status, error, conflict, change, flush, isSaved, resolveConflict } = useDocument(documentId);
  const catalog = useDocumentTypes();

  // The app frame's documents panel shows which document is open, with its live title.
  const setActiveDocument = useSetAtom(activeDocumentAtom);
  const activeId = doc.id || null;
  useEffect(() => {
    setActiveDocument({ id: activeId, title: doc.title });
  }, [setActiveDocument, activeId, doc.title]);
  useEffect(() => () => setActiveDocument(null), [setActiveDocument]);

  if (notFound) {
    return (
      <Shell>
        <div className="mx-auto max-w-md py-24 text-center">
          <h1 className="text-2xl font-semibold">Document not found</h1>
          <p className="mt-2 text-[var(--doc-muted)]">It may have been deleted, or it belongs to a team you are not signed in to.</p>
          <Link href="/" className="mt-6 inline-block rounded-full bg-[var(--doc-accent)] px-5 py-2 font-semibold text-[var(--doc-on-accent)]">
            Start a new document
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
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
    </Shell>
  );
}

/**
 * The page's one <main>: the skip link's target (layout.tsx), so it takes
 * focus but draws no outline. It sits inside a plain <div> on purpose: the App
 * Router calls focus() on a segment's first DOM node when it applies a router
 * update (a refresh, say), and a focusable <main> there took focus out of the
 * editor about a second after a new document opened. A <div> ignores it.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="doc-screen doc-editor min-h-dvh">
      <main id="main-content" tabIndex={-1} className="min-h-dvh outline-none">
        {children}
      </main>
    </div>
  );
}

type WorkspaceProps = {
  initial: PMNode | null;
  doc: ReturnType<typeof useDocument>["doc"];
  catalog: ReturnType<typeof useDocumentTypes>;
  status: SaveStatus;
  error: string | null;
  conflict: boolean;
  change: ReturnType<typeof useDocument>["change"];
  flush: ReturnType<typeof useDocument>["flush"];
  isSaved: ReturnType<typeof useDocument>["isSaved"];
  resolveConflict: ReturnType<typeof useDocument>["resolveConflict"];
};

/**
 * Where the right column goes (rightColumnMode), from the body row's width and
 * the viewport's, plus the body row's left edge for the phone sheet. Also
 * publishes the sticky toolbar's height as --toolbar-h on the row, so the
 * in-flow column sticks just under it, and --column-top for its height.
 */
function useColumnLayout(rowRef: RefObject<HTMLDivElement | null>, toolbarRef: RefObject<HTMLDivElement | null>) {
  const [layout, setLayout] = useState<{ mode: RightColumnMode; left: number }>({ mode: "inline", left: 0 });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // --column-top: where the sticky column's top is right now (below the
    // header until the page scrolls, then under the toolbar), so its height
    // ends at the viewport's bottom and its last controls clear the floating
    // buttons instead of running off-screen.
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
      const rect = row.getBoundingClientRect();
      toolbar = Math.round(toolbarRef.current?.getBoundingClientRect().height ?? 0);
      row.style.setProperty("--toolbar-h", `${toolbar}px`);
      placeTop();
      const next = { mode: rightColumnMode(rect.width, window.innerWidth), left: Math.max(0, Math.round(rect.left)) };
      setLayout((prev) => (prev.mode === next.mode && prev.left === next.left ? prev : next));
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
  return layout;
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
  // The right column: the outline on top, Tools or Section notes below (right-column-model.ts).
  const [column, setColumn] = useState<RightColumnState>(CLOSED_COLUMN);
  // The document modal (Notes / Sources / Data / Suggestions / Workflows), and the control that opened it.
  const [modalTab, setModalTab] = useState<DocumentModalTab | null>(null);
  // "upload sources" from the helper: the Sources tab opens on its upload area.
  const [sourcesMode, setSourcesMode] = useState<"upload" | null>(null);
  // The suggestion's "Restructure…": the Workflows tab opens on the restructure workflow with the type chosen.
  const [workflowsPrefill, setWorkflowsPrefill] = useState<WorkflowsPrefill | null>(null);
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  const galleryButtonRef = useRef<HTMLButtonElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  // Focus goes back here when the modal closes, else to the Sources button (DocumentModal openerRef).
  const modalOpenerRef = useRef<HTMLElement | null>(null);
  const openModal = (tab: DocumentModalTab, opener: Element | null = document.activeElement, mode: "upload" | null = null) => {
    modalOpenerRef.current = opener instanceof HTMLElement ? opener : null;
    setSourcesMode(mode);
    setModalTab(tab);
  };
  const outlineButtonRef = useRef<HTMLButtonElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const layout = useColumnLayout(rowRef, toolbarRef);
  // Passing notices replace each other; a pending decision (a sticky notice) stays until it is made.
  const { notices, notify, dismiss: dismissNotice } = useNotices();
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const undoNotice = useCallback((text: string): Notice => ({ text, actions: [{ label: "Undo", run: () => editorRef.current?.chain().focus().undo().run() }] }), []);
  const [menu, setMenu] = useState<SectionMenuTarget | null>(null);
  /** The rubric Check panel's subject (the whole document, or a section from its gutter menu). */
  const [checkTarget, setCheckTarget] = useState<CheckTarget | null>(null);
  /** The Document Gallery (header button, helper, outline card's "Choose a type", tell-me's onNeedType). */
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

  /** The suggestion's "Restructure…" (and its Apply on a typed document): the restructure workflow, to this type. */
  const openRestructure = (key: string) => {
    if (drafting) return lockedNotice();
    setWorkflowsPrefill(restructurePrefill(key));
    // Opened from inside the Document Gallery, which closes: focus comes back to its header button.
    openModal("workflows", galleryButtonRef.current);
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
    setColumn(openCheck);
  };

  const openNotesFor = (sectionId: string) => {
    if (editor) {
      const s = sectionBodyRange(editor.state.doc, sectionId);
      if (s) goToHeading(editor, s.headingPos);
    }
    setColumn(openNotes);
  };

  const setLink = () => {
    if (!editor) return;
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkDraft(prev || "https://");
  };
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  const [helperOn, setHelperOn] = useState(false);

  // A panel closed from its own X unmounts the focused button: hand focus to the
  // floating button that reopens it (Tools for Section notes too), or to the
  // editor if that button isn't there, rather than letting it drop to <body>.
  const closeColumnPanel = (slot: ColumnSlot) => {
    setColumn(slot === "outline" ? closeOutline : closeLower);
    const ref = columnCloseFocus(slot) === "outline" ? outlineButtonRef : toolsButtonRef;
    requestAnimationFrame(() => {
      const button = ref.current;
      if (button?.isConnected) button.focus();
      else editor?.commands.focus();
    });
  };

  // A floating button hides once its card opens: move focus into the card so it isn't lost.
  const openColumnPanel = (slot: ColumnSlot) => {
    setColumn(slot === "outline" ? openOutline : openTools);
    requestAnimationFrame(() => document.getElementById(slot === "outline" ? OUTLINE_SLOT_ID : TOOLS_SLOT_ID)?.focus());
  };

  const outlinePanel =
    column.outline && editor ? (
      <OutlinePanel
        editor={editor}
        type={currentType}
        status={outlineStatus.status}
        statusError={outlineStatus.error}
        notes={sectionNotes.notes}
        onChooseType={() => setGalleryOpen(true)}
        onClose={() => closeColumnPanel("outline")}
        currentSectionId={caretSection}
        locked={lockReason}
      />
    ) : null;
  const lowerPanel = !editor ? null : column.lower === "tools" ? (
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
      <header className="@container flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 pb-2 pt-6 sm:flex-nowrap sm:px-12 sm:pt-8">
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-4 gap-y-1 sm:flex-1 sm:basis-auto">
          {/* The page heading for screen readers; the title field shows it visually. */}
          <h1 className="sr-only">{doc.title.trim() || "Untitled document"}</h1>
          <label htmlFor="doc-title" className="sr-only">
            Document title
          </label>
          <input
            id="doc-title"
            value={doc.title}
            onChange={(e) => change({ title: e.target.value })}
            placeholder="Untitled document"
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="min-w-[10ch] max-w-full rounded-md bg-transparent text-[28px] font-medium tracking-tight text-[var(--ink)] outline-none placeholder:text-[var(--doc-muted)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--action)] sm:text-[32px]"
          />
          <StatusText status={status} error={error} isNew={!doc.id} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2 @min-[60rem]:gap-6">
          <HeaderButton ref={sourcesButtonRef} label="Sources" icon={HeaderSourcesIcon} expanded={modalTab !== null} onClick={(e) => openModal("sources", e.currentTarget)} />
          <HeaderButton ref={galleryButtonRef} label="Document Gallery" icon={GalleryIcon} expanded={galleryOpen} onClick={() => setGalleryOpen(true)} dot={!!classifier.suggestion} />
          <HeaderButton ref={shareButtonRef} label="Share & Export" icon={ShareExportIcon} expanded={shareOpen} onClick={() => setShareOpen(true)} />
        </div>
      </header>
      {/* The classifier's suggestion waits in the Document Gallery; say so when one arrives. */}
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
        <div className="overflow-x-auto px-5 py-3 sm:px-12">{editor && <EditorToolbar editor={editor} onLink={setLink} locked={drafting} />}</div>
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
                // Esc cancels the link form (and doesn't reach the docs panel).
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
        <div className="min-w-0 flex-1 px-5 pb-32 pt-6 sm:px-12">
          <div className={`max-w-[64rem] ${helperOn ? "doc-helper-on" : ""}`}>
            <EditorContent editor={editor} />
            {editor && <CitationLayer editor={editor} documentId={doc.id || null} sourcesKey={sourcesKey} savedAt={doc.updated_at} />}
          </div>
        </div>
        <RightColumn
          mode={layout.mode}
          sheetLeft={layout.left}
          tools={lowerPanel}
          outline={outlinePanel}
          onDismiss={() => {
            setColumn(CLOSED_COLUMN);
            // Esc in the drawer or sheet: back to a pill once it has rendered, else the editor.
            requestAnimationFrame(() => {
              const pill = outlineButtonRef.current ?? toolsButtonRef.current;
              if (pill?.isConnected) pill.focus();
              else editor?.commands.focus();
            });
          }}
        />
      </div>

      {/* Before the pills: the helper sits to their left on the same line, so it comes first in Tab order. */}
      {editor && (
        <EmptyHelper
          editor={editor}
          documentId={doc.id || null}
          typeKey={doc.type_key}
          tellMe={tellMe}
          onUploadSources={() => openModal("sources", document.activeElement, "upload")}
          onChooseType={() => setGalleryOpen(true)}
          leftEdge={layout.left}
          covered={layout.mode !== "inline" && isColumnOpen(column)}
          onVisibleChange={setHelperOn}
        />
      )}
      <FloatingActions
        outlineRef={outlineButtonRef}
        toolsRef={toolsButtonRef}
        showOutline={!column.outline}
        showTools={column.lower === null}
        onOutline={() => openColumnPanel("outline")}
        onTools={() => openColumnPanel("lower")}
      />
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
        returnFocusRef={galleryButtonRef}
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
      <SaveOutlineDialog open={saveTypeOpen} onOpenChange={setSaveTypeOpen} defaultTitle={doc.title} onSave={saveOutlineAsType} returnFocusRef={galleryButtonRef} />
      <ShareExportDialog open={shareOpen} onOpenChange={setShareOpen} documentId={doc.id || null} title={doc.title} ensureSaved={ensureSaved} notify={notify} returnFocusRef={shareButtonRef} />

      <NoticeStack notices={notices} onDismiss={dismissNotice} />
    </>
  );
}
