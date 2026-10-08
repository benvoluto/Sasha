"use client";

// The Sources panel on the editing screen: what the document is written from.
// Lists the linked sources with their reading status and summary, and adds more
// by upload, link, note or from the team's library. Adding to a new document
// saves it first, since sources link to a saved document. On the editing
// screen it is the body of the Sources dialog (sources-modal.tsx, `bare`).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LibraryIcon, Loader2, Plus, Unlink } from "@/components/icons";
import { FileDropzone } from "@/components/file-dropzone";
import {
  AddNoteForm,
  AddUrlForm,
  api,
  errorText,
  KindIcon,
  mergeFresh,
  sourceHref,
  sourceTitle,
  StatusChip,
  usePollSources,
  type LinkedSource,
} from "@/components/sources/shared";
import { SourcePicker } from "@/components/sources/source-picker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PanelHeader } from "./side-panels";

type Mode = "upload" | "url" | "note" | null;

export function SourcesPanel({
  documentId,
  documentTitle,
  ensureSaved,
  onClose,
  bare = false,
}: {
  documentId: string | null;
  documentTitle: string;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  onClose: () => void;
  /** Inside a dialog that has its own title and close button: no panel header, and it fills the dialog. */
  bare?: boolean;
}) {
  const [sources, setSources] = useState<LinkedSource[] | null>(documentId ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    if (!id) {
      setSources([]);
      return;
    }
    try {
      const { sources: list } = await api<{ sources: LinkedSource[] }>(`/api/documents/${encodeURIComponent(id)}/sources`);
      setSources(list);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Couldn't load the sources."));
      setSources((s) => s ?? []);
    }
  }, []);

  useEffect(() => {
    void load(documentId);
  }, [documentId, load]);

  usePollSources(sources ?? [], (fresh) => setSources((list) => (list ? mergeFresh(list, fresh) : list)));

  const resolve = useCallback(async () => {
    const id = await ensureSaved();
    return id ? { documentId: id } : null;
  }, [ensureSaved]);

  // Close the add form only when everything was added; after a partial upload
  // the dropzone stays open to show which files didn't make it.
  const added = useCallback(async (complete = true) => {
    if (complete) setMode(null);
    await load(await ensureSaved());
  }, [ensureSaved, load]);

  // In the dialog the dialog itself is the landmark; a nested <aside> would be noise.
  const Wrapper = bare ? "div" : "aside";

  const unlink = async (s: LinkedSource) => {
    if (!documentId) return;
    setUnlinking(s.id);
    setError(null);
    try {
      await api(`/api/documents/${encodeURIComponent(documentId)}/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      setSources((list) => list?.filter((x) => x.id !== s.id) ?? null);
    } catch (e) {
      setError(errorText(e, "Couldn't remove the source."));
    } finally {
      setUnlinking(null);
    }
  };

  return (
    <Wrapper aria-label={bare ? undefined : "Sources"} className="flex h-full min-h-0 flex-col">
      {!bare && <PanelHeader title="Sources" onClose={onClose} />}
      <div className={`flex items-center justify-between gap-2 pb-3 ${bare ? "px-6" : "px-5"}`}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-white">
              <Plus className="h-4 w-4" /> Add
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuItem onSelect={() => setMode("upload")}>Upload files</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setMode("url")}>Paste a link</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setMode("note")}>Write a note</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPickerOpen(true)}>From the library…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Link href="/library" className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]">
          <LibraryIcon className="h-4 w-4" /> Library
        </Link>
      </div>

      <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto pb-6 ${bare ? "px-6" : "px-5"}`}>
        {mode && (
          <section aria-label={mode === "upload" ? "Upload files" : mode === "url" ? "Add a link" : "Add a note"} className="space-y-2 rounded-xl border border-[var(--doc-line)] p-3">
            {mode === "upload" && (
              <>
                <FileDropzone compact resolveDocumentId={ensureSaved} label={documentTitle.trim() || "this document"} onUploaded={(_, complete) => void added(complete)} />
                <button type="button" onClick={() => setMode(null)} className="text-xs text-[var(--doc-muted)] hover:underline">
                  Done
                </button>
              </>
            )}
            {mode === "url" && <AddUrlForm idPrefix="panel" resolve={resolve} onAdded={() => void added()} onCancel={() => setMode(null)} />}
            {mode === "note" && <AddNoteForm idPrefix="panel" resolve={resolve} onAdded={() => void added()} onCancel={() => setMode(null)} />}
          </section>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {sources === null ? (
          <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading sources…
          </p>
        ) : sources.length === 0 ? (
          !mode && <p className="text-sm text-[var(--doc-muted)]">No sources yet. Add the files, links and notes this document is written from.</p>
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => {
              const open = expanded === s.id;
              const href = sourceHref(s);
              return (
                <li key={s.id} className="rounded-xl border border-[var(--doc-line)] px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <KindIcon kind={s.kind} className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : s.id)}
                      className="min-w-0 flex-1 text-left text-sm font-medium leading-snug hover:text-[var(--doc-accent)]"
                    >
                      <span className="line-clamp-2 break-words">{sourceTitle(s)}</span>
                    </button>
                    <StatusChip status={s.extraction_status} error={s.extraction_error} />
                  </div>
                  {s.extraction_status === "error" || s.extraction_status === "partial"
                    ? s.extraction_error && <p className="mt-1.5 text-xs text-red-700 dark:text-red-300">{s.extraction_error}</p>
                    : s.summary && <p className={`mt-1.5 text-xs leading-relaxed text-[var(--doc-muted)] ${open ? "" : "line-clamp-3"}`}>{s.summary}</p>}
                  {open && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {href && (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]">
                          <ExternalLink className="h-3.5 w-3.5" /> {s.kind === "url" ? "Open page" : "Open file"}
                        </a>
                      )}
                      <Link
                        href={`/library?source=${encodeURIComponent(s.id)}`}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
                      >
                        <LibraryIcon className="h-3.5 w-3.5" /> Details
                      </Link>
                      <button
                        type="button"
                        onClick={() => void unlink(s)}
                        disabled={unlinking === s.id}
                        className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--doc-muted)] hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950/50 dark:hover:text-red-300"
                      >
                        {unlinking === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />} Remove from document
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {sources && sources.length > 0 && <p className="text-xs text-[var(--doc-muted)]">Removing a source from the document keeps it in the library.</p>}
      </div>

      <SourcePicker open={pickerOpen} onOpenChange={setPickerOpen} documentId={ensureSaved} linkedIds={(sources ?? []).map((s) => s.id)} onLinked={() => void added()} />
    </Wrapper>
  );
}
