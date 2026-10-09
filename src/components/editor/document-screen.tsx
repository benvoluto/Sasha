"use client";

// The editing screen: the first thing a person sees, inside the app frame
// (rail and documents panel, src/components/shell). A header with the title,
// type and sharing; a sticky formatting toolbar; the document on a plain white
// page; a right column with the living outline over the tools or section notes
// (right-column.tsx); floating Outline / Tools / Sources buttons. Sources and
// the Notes control beside the title open the document modal (Notes / Sources /
// Data / Suggestions / Workflows). Each heading has a gutter button that opens the section's actions
// (draft, rewrite, notes). Changes a workflow run proposes are applied here, in
// the editor, as one undo step (apply-workflow-change.ts).

import { OrganizationSwitcher, useOrganization } from "@clerk/nextjs";
import { EditorContent, useEditor } from "@tiptap/react";
import { useSetAtom } from "jotai";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Copy, Loader2, NoteIcon, ShareArrowIcon } from "@/components/icons";
import { useDevAuthBypass } from "@/components/dev-auth-context";
import { activeDocumentAtom } from "@/components/shell/active-document";
import type { LinkedSource } from "@/components/sources/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { ClassifierChip } from "./classifier-chip";
import { DocumentModal } from "./document-modal";
import type { DocumentModalTab } from "./document-modal-model";
import { EditorToolbar } from "./editor-toolbar";
import { ExportMenu } from "./export-menu";
import { documentExtensions, newSectionId } from "./extensions";
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
  openCheck,
  openNotes,
  rightColumnMode,
  toggleOutline,
  toggleTools,
  type ColumnSlot,
  type RightColumnMode,
  type RightColumnState,
} from "./right-column-model";
import { ToolsPanel } from "./side-panels";
import { sectionBodyRange } from "./tracked-range";
import { createDocumentOfType, findType, SaveOutlineDialog, StartFromTypeStrip, TypeGallery, TypePicker, useDocumentTypes } from "./type-picker";
import { useClassifier } from "./use-classifier";
import { useDocument, type SaveStatus } from "./use-document";
import { useOutlineStatus } from "./use-outline-status";
import { busyAnnouncement, useSectionGeneration } from "./use-section-generation";
import { linkedSourcesKey, useSuggestionsRefresh } from "./use-suggestions-refresh";
import { chipApplyAction, restructurePrefill, type WorkflowsPrefill } from "./workflows-pane-model";

/** Who can see the document, and the team switcher. Uses Clerk's organization hooks, so it is never mounted under the dev auth bypass. */
function TeamSharing() {
  const { organization } = useOrganization();
  return (
    <>
      <p className="text-sm">
        {organization
          ? `Everyone in ${organization.name} can open and edit this document.`
          : "Only you can see this document. Create or join a team to share it with others."}
      </p>
      <OrganizationSwitcher hidePersonal={false} afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
    </>
  );
}

function SharePopover({ documentId }: { documentId: string | null }) {
  // Under the dev auth bypass there is no Clerk user, and the organization
  // hooks would open Clerk's "Organizations feature required" modal.
  const bypass = useDevAuthBypass();
  const [copied, setCopied] = useState(false);
  const url = documentId && typeof window !== "undefined" ? `${window.location.origin}/d/${documentId}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the link stays visible for manual copying */
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Share"
          title="Share"
          className="flex h-11 w-11 shrink-0 items-center justify-center gap-2.5 rounded-xl border border-[var(--go-line)] text-[18px] font-semibold text-[var(--go)] hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] data-[state=open]:bg-[var(--go-soft)] sm:h-12 sm:w-auto sm:px-5"
        >
          <ShareArrowIcon className="h-6 w-6" /> <span className="hidden sm:inline">Share</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-xl">
        {bypass ? <p className="text-sm">Local development: signed in as the developer user, so teams are unavailable.</p> : <TeamSharing />}
        {documentId ? (
          <div className="flex items-center gap-2">
            <input readOnly value={url} aria-label="Document link" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-md border border-[var(--doc-line)] bg-transparent px-2 py-1.5 text-xs" />
            <button type="button" onClick={copy} className="flex items-center gap-1 rounded-md bg-[var(--doc-accent)] px-2.5 py-1.5 text-xs font-semibold text-[var(--doc-on-accent)]">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        ) : (
          <p className="text-xs text-[var(--doc-muted)]">The link appears once the document has been saved.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function StatusText({ status, error, isNew }: { status: SaveStatus; error: string | null; isNew: boolean }) {
  const text =
    status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? (error ?? "Not saved") : status === "conflict" ? "Not saved" : isNew ? "Not saved yet" : "";
  return (
    <span role="status" aria-live="polite" className={`text-xs ${status === "error" || status === "conflict" ? "text-red-600 dark:text-red-400" : "text-[var(--doc-muted)]"}`}>
      {status === "saving" && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
      {text}
    </span>
  );
}

export function DocumentScreen({ documentId }: { documentId: string | null }) {
  const { doc, loading, notFound, status, error, conflict, change, flush, resolveConflict } = useDocument(documentId);
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
          resolveConflict={resolveConflict}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="doc-screen doc-editor min-h-dvh">{children}</div>;
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

function Workspace({ initial, doc, catalog, status, error, conflict, change, flush, resolveConflict }: WorkspaceProps) {
  const router = useRouter();
  const types = catalog.types;
  const currentType = findType(types, doc.type_key);
  // The right column: the outline on top, Tools or Section notes below (right-column-model.ts).
  const [column, setColumn] = useState<RightColumnState>(CLOSED_COLUMN);
  // The document modal (Notes / Sources / Data / Suggestions / Workflows), and the control that opened it.
  const [modalTab, setModalTab] = useState<DocumentModalTab | null>(null);
  // The classifier chip's "Restructure…": the Workflows tab opens on the restructure workflow with the type chosen.
  const [workflowsPrefill, setWorkflowsPrefill] = useState<WorkflowsPrefill | null>(null);
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  const notesButtonRef = useRef<HTMLButtonElement>(null);
  const [modalOpener, setModalOpener] = useState<"sources" | "notes">("sources");
  const openModal = (tab: DocumentModalTab, from: "sources" | "notes") => {
    setModalOpener(from);
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
  /** The gallery's purpose: set this document's type, or start a new document of a type. */
  const [gallery, setGallery] = useState<"set" | "new" | null>(null);
  const [saveTypeOpen, setSaveTypeOpen] = useState(false);
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
    editorProps: { attributes: { class: "doc-prose", "aria-label": "Document" } },
    onUpdate: ({ editor: e }) => change({ content_json: e.getJSON() as PMNode }),
  });
  editorRef.current = editor;

  // Whether the document body is empty, for the "Start from a type" strip.
  const [isEmpty, setIsEmpty] = useState(!initial);
  useEffect(() => {
    if (!editor) return;
    const read = () => setIsEmpty(editor.isEmpty);
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);

  const ensureSaved = useCallback(async () => {
    // A blank new document has nothing pending, so flush alone wouldn't create
    // it; record its title as a change so the save goes out.
    if (!docIdRef.current) change({ title: titleRef.current });
    // The id comes from the save itself: docIdRef only updates when this
    // component re-renders, which happens after the save resolves.
    return (await flush()) || null;
  }, [change, flush]);

  const generation = useSectionGeneration({ editor, ensureSaved, notify });
  const outlineStatus = useOutlineStatus({ documentId: doc.id, typeKey: currentType?.key ?? doc.type_key, saveStatus: status });
  const sectionNotes = useSectionNotes(doc.id);
  const caretSection = useCaretSectionId(editor);

  /** Set the type; with text already there, merge its outline in (apply-outline.ts). `source` is "classifier" from the chip. */
  const chooseType = async (t: DocumentTypeSummary | null, source: "user" | "classifier" = "user") => {
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
      ed.chain().focus().insertContent(tableSnapshotNodes(snap, { rows: snap.rows.length, at: new Date().toISOString() })).run();
      setModalTab(null);
      // The dialog held focus until now (and leaves it alone after an insert): back to the text.
      requestAnimationFrame(() => editorRef.current?.commands.focus(null, { scrollIntoView: true }));
      notify(undoNotice("Table inserted."));
    },
    [notify, undoNotice],
  );

  /** The Workflows tab's "Apply to document": the run's change as one undo step after a snapshot, then a notice (phase6-spec.md §8.2). */
  const applyChange = useCallback(
    async (proposed: ProposedChange): Promise<AppliedChange> => {
      const ed = editorRef.current;
      if (!ed) return { result: null, detail: "The editor isn't ready yet.", typeKey: null };
      const out = await applyWorkflowChange(ed, proposed, {
        ensureSaved,
        snapshot,
        sectionsFor: (key) => findType(types, key)?.sections ?? null,
        newId: newSectionId,
        restructure: applyRestructurePlan,
      });
      if (out.typeKey) change({ type_key: out.typeKey, type_source: "restructure" });
      if (out.result === "applied") notify(undoNotice(`${proposed.title}: ${out.detail}`));
      else notify({ text: out.detail, tone: out.result === null ? "error" : undefined });
      return out;
    },
    [ensureSaved, snapshot, types, change, notify, undoNotice],
  );

  /** A workflow finding's location: the section's heading, in view. The dialog closes first. */
  const jumpToSection = useCallback((sectionId: string) => {
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      const s = ed ? sectionBodyRange(ed.state.doc, sectionId) : null;
      if (ed && s) goToHeading(ed, s.headingPos);
    });
  }, []);

  /** The chip's "Restructure…" (and its Apply on a typed document): the restructure workflow, to this type. */
  const openRestructure = (key: string) => {
    setWorkflowsPrefill(restructurePrefill(key));
    openModal("workflows", "sources");
  };

  /** A new document of the type, opened in place of this one. Resolves to an error message, or null. */
  const startNewOfType = async (t: DocumentTypeSummary): Promise<string | null> => {
    try {
      const id = await createDocumentOfType(t.key);
      router.push(`/d/${id}`);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Couldn't create the document.";
    }
  };

  const saveOutlineAsType = async (title: string): Promise<string | null> => {
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

  const showStrip = !doc.id && !doc.type_key && isEmpty && types.length > 0;

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

  const outlinePanel =
    column.outline && editor ? (
      <OutlinePanel
        editor={editor}
        type={currentType}
        status={outlineStatus.status}
        statusError={outlineStatus.error}
        notes={sectionNotes.notes}
        onChooseType={() => setGallery("set")}
        onClose={() => closeColumnPanel("outline")}
      />
    ) : null;
  const lowerPanel = !editor ? null : column.lower === "tools" ? (
    <ToolsPanel editor={editor} documentId={doc.id} ensureSaved={ensureSaved} onClose={() => closeColumnPanel("lower")} onCheckDocument={() => openCheckFor(null)} />
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
      <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-6 sm:px-12 sm:pt-8">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          <label htmlFor="doc-title" className="sr-only">
            Document title
          </label>
          <input
            id="doc-title"
            value={doc.title}
            onChange={(e) => change({ title: e.target.value })}
            placeholder="Untitled document"
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="min-w-[10ch] max-w-full rounded-md bg-transparent text-[28px] font-medium tracking-tight text-[var(--ink)] outline-none placeholder:text-[var(--doc-muted)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--action)] sm:text-[32px]"
          />
          <TypePicker types={types} value={doc.type_key} onChange={(t) => chooseType(t)} onBrowse={() => setGallery("set")} onSaveOutline={() => setSaveTypeOpen(true)} />
          <button
            ref={notesButtonRef}
            type="button"
            onClick={() => openModal("notes", "notes")}
            aria-haspopup="dialog"
            aria-expanded={modalTab === "notes"}
            aria-label="Notes"
            title={doc.notes.trim() ? "Notes" : "Add notes"}
            className="relative flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 rounded-full text-[15px] font-medium text-[var(--go)] hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] aria-expanded:bg-[var(--go-soft)] sm:h-9 sm:w-auto sm:px-3.5"
          >
            <NoteIcon className="h-5 w-5 shrink-0 sm:h-[18px] sm:w-[18px]" />
            <span className="hidden sm:inline">Notes</span>
            {doc.notes.trim() && <span aria-hidden className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[var(--go)] sm:static sm:h-1.5 sm:w-1.5" />}
          </button>
          <ClassifierChip
            suggestion={classifier.suggestion}
            applyLabel={chipApplyAction(doc.type_key).label}
            onApply={(key) => {
              // A typed document (the drift case) restructures rather than only tagging headings.
              if (chipApplyAction(doc.type_key).restructure) return openRestructure(key);
              const t = findType(types, key);
              if (t) void chooseType(t, "classifier");
            }}
            onRestructure={openRestructure}
            onDismiss={(key) => void classifier.dismiss(key)}
          />
          <StatusText status={status} error={error} isNew={!doc.id} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ExportMenu documentId={doc.id || null} title={doc.title} ensureSaved={ensureSaved} notify={notify} />
          <SharePopover documentId={doc.id} />
        </div>
      </header>

      {conflict && (
        <div role="alert" className="mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-12 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <span className="flex-1">Someone else saved this document while you were editing. Your latest changes are not saved.</span>
          <button type="button" onClick={() => void resolveConflict("theirs").then(() => window.location.reload())} className="rounded-md border border-current px-3 py-1 font-medium">
            Load their version
          </button>
          <button type="button" onClick={() => void resolveConflict("mine")} className="rounded-md bg-amber-900 px-3 py-1 font-medium text-white dark:bg-amber-200 dark:text-amber-950">
            Keep mine
          </button>
        </div>
      )}

      <div ref={toolbarRef} className="sticky top-0 z-[15] bg-[var(--editor-bg)]/95 backdrop-blur">
        <div className="overflow-x-auto px-5 py-3 sm:px-12">{editor && <EditorToolbar editor={editor} onLink={setLink} />}</div>
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
              className="min-w-0 flex-1 rounded-md border border-[var(--divider)] bg-transparent px-2 py-1 outline-none focus:border-[var(--action)]"
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
        <main className="min-w-0 flex-1 px-5 pb-32 pt-6 sm:px-12">
          <div className="max-w-[64rem]">
            <EditorContent editor={editor} />
            {editor && <CitationLayer editor={editor} documentId={doc.id || null} sourcesKey={sourcesKey} savedAt={doc.updated_at} />}
          </div>
          {showStrip && <StartFromTypeStrip types={types} onChoose={startNewOfType} onBrowse={() => setGallery("new")} />}
        </main>
        <RightColumn
          mode={layout.mode}
          sheetLeft={layout.left}
          top={outlinePanel}
          bottom={lowerPanel}
          onDismiss={() => {
            setColumn(CLOSED_COLUMN);
            editor?.commands.focus();
          }}
        />
      </div>

      <FloatingActions
        ref={sourcesButtonRef}
        outlineRef={outlineButtonRef}
        toolsRef={toolsButtonRef}
        outlineOpen={column.outline}
        toolsOpen={column.lower === "tools"}
        sourcesOpen={modalTab !== null && modalOpener === "sources"}
        onOutline={() => setColumn(toggleOutline)}
        onTools={() => setColumn(toggleTools)}
        onSources={() => openModal("sources", "sources")}
      />
      <DocumentModal
        tab={modalTab}
        onTabChange={(t) => {
          setModalTab(t);
          // The chip's prefill lasts while the Workflows tab is showing.
          if (t !== "workflows") setWorkflowsPrefill(null);
        }}
        documentId={doc.id || null}
        documentTitle={doc.title}
        typeKey={doc.type_key}
        notes={doc.notes}
        onNotesChange={(notes) => change({ notes })}
        saveStatus={status}
        saveError={error}
        ensureSaved={ensureSaved}
        returnFocusRef={modalOpener === "notes" ? notesButtonRef : sourcesButtonRef}
        onSourcesChange={onSourcesChange}
        onInsertTable={insertTable}
        onApplyWorkflowChange={applyChange}
        onJumpToSection={jumpToSection}
        workflowsPrefill={workflowsPrefill}
        onWorkflowsPrefillDone={() => setWorkflowsPrefill(null)}
        onLearnedType={async (key) => {
          // The type was just saved: load it into the picker before choosing it.
          await catalog.reload();
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
          onRun={(req) => void generation.run(req)}
          onNotes={openNotesFor}
          onCheck={openCheckFor}
        />
      )}

      <TypeGallery
        open={gallery !== null}
        onOpenChange={(o) => !o && setGallery(null)}
        types={types}
        loading={catalog.loading}
        error={catalog.error}
        current={gallery === "set" ? (currentType?.key ?? null) : null}
        title={gallery === "new" ? "New document from a type" : "Document types"}
        onChoose={async (t) => {
          if (gallery === "new") {
            const err = await startNewOfType(t);
            if (err) return err;
          } else {
            await chooseType(t);
          }
          setGallery(null);
        }}
      />
      <SaveOutlineDialog open={saveTypeOpen} onOpenChange={setSaveTypeOpen} defaultTitle={doc.title} onSave={saveOutlineAsType} />

      <NoticeStack notices={notices} onDismiss={dismissNotice} />
    </>
  );
}
