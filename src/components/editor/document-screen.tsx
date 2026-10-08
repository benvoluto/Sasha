"use client";

// The editing screen: the first thing a person sees. A header with the
// document switcher, title, type, sources and sharing; a card holding the
// toolbar, the document, and the outline panel on the left and the tools or
// sources panel on the right.

import { OrganizationSwitcher, UserButton, useOrganization } from "@clerk/nextjs";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CaretUpDown, Copy, LibraryIcon, Loader2, OutlineIcon, Share, SourcesIcon, SparkleIcon } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { docFromOutline, type PMNode } from "@/lib/documents/sections";
import type { DocumentTypeOption } from "@/lib/documents/types";
import { DocumentSwitcher } from "./document-switcher";
import { EditorToolbar } from "./editor-toolbar";
import { documentExtensions, newSectionId } from "./extensions";
import { OutlinePanel, ToolsPanel } from "./side-panels";
import { SourcesPanel } from "./sources-panel";
import { useDocument, type SaveStatus } from "./use-document";

function useDocumentTypes(): DocumentTypeOption[] {
  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  useEffect(() => {
    fetch("/api/document-types")
      .then((r) => (r.ok ? r.json() : { types: [] }))
      .then((b) => setTypes(b.types ?? []))
      .catch(() => setTypes([]));
  }, []);
  return types;
}

function TypePicker({ types, value, onChange }: { types: DocumentTypeOption[]; value: string | null; onChange: (t: DocumentTypeOption | null) => void }) {
  const current = types.find((t) => t.key === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-1 rounded-md px-2 py-1 text-[17px] hover:bg-[var(--doc-accent-soft)]">
          <span className={current ? "" : "text-[var(--doc-muted)]"}>{current?.title ?? "Choose type"}</span>
          <CaretUpDown className="h-4 w-4 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] min-w-56 overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        {types.map((t) => (
          <DropdownMenuItem key={t.key} onSelect={() => onChange(t)}>
            <Check className={`h-4 w-4 ${t.key === value ? "opacity-100" : "opacity-0"}`} /> {t.title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <Check className={`h-4 w-4 ${value ? "opacity-0" : "opacity-100"}`} /> No type (freeform)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SharePopover({ documentId }: { documentId: string | null }) {
  const { organization } = useOrganization();
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
        <button type="button" className="flex h-11 items-center gap-2 rounded-full px-4 text-[17px] font-semibold text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]">
          <Share className="h-5 w-5" /> Share
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-xl">
        <p className="text-sm">
          {organization
            ? `Everyone in ${organization.name} can open and edit this document.`
            : "Only you can see this document. Create or join a team to share it with others."}
        </p>
        <OrganizationSwitcher hidePersonal={false} afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
        {documentId ? (
          <div className="flex items-center gap-2">
            <input readOnly value={url} aria-label="Document link" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-md border border-[var(--doc-line)] bg-transparent px-2 py-1.5 text-xs" />
            <button type="button" onClick={copy} className="flex items-center gap-1 rounded-md bg-[var(--doc-accent)] px-2.5 py-1.5 text-xs font-semibold text-white">
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

/** Headings for the outline's sections that the document doesn't have yet, appended at the end. */
function appendMissingSections(editor: Editor, type: DocumentTypeOption) {
  const have = new Set<string>();
  editor.state.doc.forEach((node) => {
    if (node.type.name === "heading" && node.attrs.specKey) have.add(String(node.attrs.specKey));
  });
  const missing = type.sections.filter((s) => !have.has(s.key));
  if (missing.length === 0) return 0;
  const add = docFromOutline(missing, newSectionId).content ?? [];
  editor.chain().focus("end").insertContentAt(editor.state.doc.content.size, add).run();
  return missing.length;
}

export function DocumentScreen({ documentId }: { documentId: string | null }) {
  const { doc, loading, notFound, status, error, conflict, change, flush, resolveConflict } = useDocument(documentId);
  const types = useDocumentTypes();

  if (notFound) {
    return (
      <Shell>
        <div className="mx-auto max-w-md py-24 text-center">
          <h1 className="text-2xl font-semibold">Document not found</h1>
          <p className="mt-2 text-[var(--doc-muted)]">It may have been deleted, or it belongs to a team you are not signed in to.</p>
          <Link href="/" className="mt-6 inline-block rounded-full bg-[var(--doc-accent)] px-5 py-2 font-semibold text-white">
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
          types={types}
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
  return <div className="doc-screen min-h-screen bg-[var(--doc-bg)] text-[var(--doc-ink)]">{children}</div>;
}

type WorkspaceProps = {
  initial: PMNode | null;
  doc: ReturnType<typeof useDocument>["doc"];
  types: DocumentTypeOption[];
  status: SaveStatus;
  error: string | null;
  conflict: boolean;
  change: ReturnType<typeof useDocument>["change"];
  flush: ReturnType<typeof useDocument>["flush"];
  resolveConflict: ReturnType<typeof useDocument>["resolveConflict"];
};

function Workspace({ initial, doc, types, status, error, conflict, change, flush, resolveConflict }: WorkspaceProps) {
  const [outlineOpen, setOutlineOpen] = useState(false);
  // The right-hand slot holds one panel at a time.
  const [rightPanel, setRightPanel] = useState<"tools" | "sources" | null>(null);
  const toolsOpen = rightPanel === "tools";
  const sourcesOpen = rightPanel === "sources";
  const toggleRight = (panel: "tools" | "sources") => setRightPanel((p) => (p === panel ? null : panel));
  const [notice, setNotice] = useState<string | null>(null);
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
          setNotice(`Deleted “${heading || "Untitled section"}”.`);
        },
      }),
    [snapshot],
  );

  const editor = useEditor({
    extensions,
    content: initial ?? undefined,
    immediatelyRender: false,
    autofocus: initial ? false : "end",
    editorProps: { attributes: { class: "doc-prose", "aria-label": "Document" } },
    onUpdate: ({ editor: e }) => change({ content_json: e.getJSON() as PMNode }),
  });

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const ensureSaved = useCallback(async () => {
    // A blank new document has nothing pending, so flush alone wouldn't create
    // it; record its title as a change so the save goes out.
    if (!docIdRef.current) change({ title: titleRef.current });
    // The id comes from the save itself: docIdRef only updates when this
    // component re-renders, which happens after the save resolves.
    return (await flush()) || null;
  }, [change, flush]);

  const chooseType = async (t: DocumentTypeOption | null) => {
    change({ type_key: t?.key ?? null });
    if (!editor) return;
    if (!t) {
      editor.commands.focus();
      return;
    }
    if (editor.isEmpty) {
      editor.commands.setContent(docFromOutline(t.sections, newSectionId), true);
      // Caret in the first section's empty paragraph, ready to write.
      const first = editor.state.doc.firstChild;
      editor.chain().focus().setTextSelection(first ? first.nodeSize + 1 : 1).run();
      setNotice(`Started from the ${t.title} outline.`);
      return;
    }
    await snapshot(`Before applying the ${t.title} outline`);
    const added = appendMissingSections(editor, t);
    setNotice(added ? `Added ${added} section${added === 1 ? "" : "s"} from the ${t.title} outline at the end.` : `Your document already has every ${t.title} section.`);
  };

  const setLink = () => {
    if (!editor) return;
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkDraft(prev || "https://");
  };
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pb-6 pt-6 sm:px-10 sm:pt-8">
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-5 gap-y-2 md:w-auto md:flex-1">
          <DocumentSwitcher currentId={doc.id} />
          <label htmlFor="doc-title" className="sr-only">
            Document title
          </label>
          <input
            id="doc-title"
            value={doc.title}
            onChange={(e) => change({ title: e.target.value })}
            placeholder="Untitled document"
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="min-w-[10ch] max-w-full bg-transparent text-[22px] font-medium tracking-tight outline-none placeholder:text-[var(--doc-muted)] sm:max-w-[28rem]"
          />
          <TypePicker types={types} value={doc.type_key} onChange={chooseType} />
          <StatusText status={status} error={error} isNew={!doc.id} />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={sourcesOpen}
            onClick={() => toggleRight("sources")}
            className={`flex h-11 items-center gap-2 rounded-full px-5 text-[17px] font-semibold text-[var(--doc-accent)] shadow-sm hover:bg-[var(--doc-accent-soft)] ${
              sourcesOpen ? "bg-[var(--doc-accent-soft)]" : "bg-[var(--doc-surface)]"
            }`}
          >
            <SourcesIcon className="h-5 w-5" /> Sources
          </button>
          <Link
            href="/library"
            aria-label="Sources library"
            title="Sources library"
            className="grid h-11 w-11 place-items-center rounded-full text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
          >
            <LibraryIcon className="h-5 w-5" />
          </Link>
          <SharePopover documentId={doc.id} />
          <div className="ml-1 grid h-11 w-11 place-items-center">
            <UserButton />
          </div>
        </div>
      </header>

      {conflict && (
        <div role="alert" className="mx-4 mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-10 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <span className="flex-1">Someone else saved this document while you were editing. Your latest changes are not saved.</span>
          <button type="button" onClick={() => void resolveConflict("theirs").then(() => window.location.reload())} className="rounded-md border border-current px-3 py-1 font-medium">
            Load their version
          </button>
          <button type="button" onClick={() => void resolveConflict("mine")} className="rounded-md bg-amber-900 px-3 py-1 font-medium text-white dark:bg-amber-200 dark:text-amber-950">
            Keep mine
          </button>
        </div>
      )}

      <main className="mx-2 mb-10 overflow-hidden rounded-2xl bg-[var(--doc-surface)] shadow-[0_1px_3px_rgba(16,24,40,0.06),0_8px_24px_rgba(16,24,40,0.05)] sm:mx-10">
        <div className="sticky top-[env(safe-area-inset-top,0px)] z-20 grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-[var(--doc-line)] bg-[var(--doc-toolbar)] px-3 py-3 backdrop-blur sm:px-6">
          <button
            type="button"
            aria-pressed={outlineOpen}
            onClick={() => setOutlineOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[17px] font-semibold text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
          >
            <OutlineIcon className="h-5 w-5" /> <span className="hidden sm:inline">Outline</span>
          </button>
          <div className="min-w-0 overflow-x-auto">{editor && <EditorToolbar editor={editor} onLink={setLink} />}</div>
          <button
            type="button"
            aria-pressed={toolsOpen}
            onClick={() => toggleRight("tools")}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[17px] font-semibold text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
          >
            <SparkleIcon className="h-5 w-5" /> <span className="hidden sm:inline">Tools</span>
          </button>
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
            className="flex flex-wrap items-center gap-2 border-b border-[var(--doc-line)] px-6 py-2 text-sm"
          >
            <label htmlFor="link-url">Link to</label>
            <input id="link-url" autoFocus value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)} className="min-w-0 flex-1 rounded-md border border-[var(--doc-line)] bg-transparent px-2 py-1" />
            <button type="submit" className="rounded-md bg-[var(--doc-accent)] px-3 py-1 font-semibold text-white">
              Apply
            </button>
            <button type="button" onClick={() => setLinkDraft(null)} className="rounded-md px-2 py-1 text-[var(--doc-muted)]">
              Cancel
            </button>
          </form>
        )}

        <div className="relative flex min-h-[70vh]">
          {outlineOpen && editor && (
            <div className="absolute inset-y-0 left-0 z-10 w-72 max-w-[85vw] border-r border-[var(--doc-line)] bg-[var(--doc-surface)] lg:static lg:w-64">
              <OutlinePanel editor={editor} onClose={() => setOutlineOpen(false)} />
            </div>
          )}
          <div className="min-w-0 flex-1 px-5 py-10 sm:px-10">
            <div className="mx-auto max-w-[44rem]">
              <EditorContent editor={editor} />
            </div>
          </div>
          {toolsOpen && editor && (
            <div className="absolute inset-y-0 right-0 z-10 w-80 max-w-[85vw] border-l border-[var(--doc-line)] bg-[var(--doc-surface)] lg:static">
              <ToolsPanel editor={editor} documentId={doc.id} ensureSaved={ensureSaved} onClose={() => setRightPanel(null)} />
            </div>
          )}
          {sourcesOpen && (
            <div className="absolute inset-y-0 right-0 z-10 w-80 max-w-[85vw] border-l border-[var(--doc-line)] bg-[var(--doc-surface)] lg:static">
              <SourcesPanel documentId={doc.id || null} documentTitle={doc.title} ensureSaved={ensureSaved} onClose={() => setRightPanel(null)} />
            </div>
          )}
        </div>
      </main>

      {notice && (
        <div role="status" className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-[var(--doc-ink)] px-4 py-2 text-sm text-[var(--doc-bg)] shadow-lg">
          {notice}
          <button
            type="button"
            onClick={() => {
              editor?.chain().focus().undo().run();
              setNotice(null);
            }}
            className="font-semibold underline underline-offset-2"
          >
            Undo
          </button>
        </div>
      )}
    </>
  );
}
