"use client";

// The overview's Notes tab (redesign3-spec.md §7): a "New note" card, then
// every notes item of the team (GET /api/notes) as cards, newest first. A
// standalone note opens in the note dialog (edit with dictation, delete,
// "Start a document"); a document's notes card opens /d/<id>?notes=1.
//
// CONTRACT (redesign 3 foundation): the overview (shell-overview track)
// renders <NotesTab query={…} />; the notes track owns the implementation.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, NotesTabIcon, Plus } from "@/components/icons";
import { findType, useDocumentTypes } from "@/components/editor/type-picker";
import { OVERVIEW_GRID, OVERVIEW_GUTTER } from "@/components/overview/overview-layout";
import { when } from "@/components/sources/shared";
import { TypeIcon } from "@/components/type-icon";
import { OPEN_NOTES_PARAM } from "@/lib/documents/card-text";
import type { Note, NoteResponse, NotesFeedItem, NotesFeedResponse } from "@/lib/notes/contract";
import { NoteDialog } from "./note-dialog";
import { documentNotesName, noteCardName, removeNote, upsertNote } from "./notes-model";

export type NotesTabProps = {
  /** The overview's search text (debounced by the overview); "" shows everything. */
  query: string;
};

/** The overview's columns and gutter, so notes line up with the document cards; the tabpanel adds the top offset. */
const GRID = `${OVERVIEW_GRID} ${OVERVIEW_GUTTER}`;
const CARD =
  "relative flex h-full min-h-[150px] w-full flex-col overflow-hidden rounded-2xl border border-[var(--card-line)] bg-[var(--card-bg)] p-5 text-left transition-shadow hover:shadow-md sm:h-[188px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]";

export function NotesTab({ query }: NotesTabProps) {
  const router = useRouter();
  const { types } = useDocumentTypes();
  const [items, setItems] = useState<NotesFeedItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [open, setOpen] = useState<Note | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const ctrl = new AbortController();
    request.current = ctrl;
    try {
      const res = await fetch(`/api/notes${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as NotesFeedResponse;
      setItems(data.items);
      setLoadError(false);
    } catch {
      if (!ctrl.signal.aborted) setLoadError(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  const newNote = async () => {
    if (pending) return;
    setPending("new");
    setActionError(null);
    const res = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as NoteResponse | null) : null;
    setPending(null);
    if (data?.note) setOpen(data.note);
    else setActionError("Couldn't make a note. Try again.");
  };

  const openNote = async (id: string) => {
    if (pending) return;
    setPending(id);
    setActionError(null);
    const res = await fetch(`/api/notes/${id}`).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as NoteResponse | null) : null;
    setPending(null);
    if (data?.note) setOpen(data.note);
    else {
      setActionError(res?.status === 404 ? "That note was deleted." : "Couldn't open the note. Try again.");
      if (res?.status === 404) setItems((list) => (list ? removeNote(list, id) : list));
    }
  };

  // After the dialog: the note's card if it's still there, else the New note card.
  const openId = open?.id;
  const returnFocus = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const card = openId ? el.querySelector<HTMLElement>(`[data-note-id="${openId}"]`) : null;
    (card ?? el.querySelector<HTMLElement>("[data-new-note]"))?.focus();
  }, [openId]);

  const empty = items !== null && items.length === 0;

  return (
    <div ref={root}>
      <ul className={GRID} aria-busy={items === null || undefined}>
        <li>
          <button
            type="button"
            data-new-note
            onClick={() => void newNote()}
            aria-busy={pending === "new" || undefined}
            className={`${CARD} items-start justify-center border-2 border-dashed bg-transparent text-[var(--tab-ink)]`}
          >
            {pending === "new" ? <Loader2 className="h-8 w-8 animate-spin" aria-hidden /> : <Plus className="h-8 w-8" aria-hidden />}
            <span className="mt-3 text-[19px] font-medium">New note</span>
          </button>
        </li>
        {items?.map((item) =>
          item.kind === "note" ? (
            <li key={`n:${item.id}`}>
              <button
                type="button"
                data-note-id={item.id}
                onClick={() => void openNote(item.id)}
                aria-label={noteCardName(item.title)}
                aria-describedby={item.excerpt ? `note-${item.id}-excerpt note-${item.id}-date` : `note-${item.id}-date`}
                aria-busy={pending === item.id || undefined}
                className={CARD}
              >
                <NotesTabIcon className="h-8 w-8 shrink-0 text-[var(--tab-ink)]" aria-hidden />
                <span className={`mt-3 line-clamp-2 text-[19px] font-medium ${item.title ? "text-[var(--card-title)]" : "text-[var(--card-untitled)]"}`}>
                  {noteCardName(item.title)}
                </span>
                {item.excerpt && (
                  <span id={`note-${item.id}-excerpt`} className="mt-1.5 line-clamp-2 text-[14px] text-[var(--card-sub)]">
                    {item.excerpt}
                  </span>
                )}
                <span id={`note-${item.id}-date`} className="mt-auto pt-2 text-[13px] text-[var(--card-untitled)]">
                  {when(item.updated_at)}
                </span>
              </button>
            </li>
          ) : (
            <li key={`d:${item.document_id}`}>
              <DocumentNotesCard item={item} type={findType(types, item.type_key)} />
            </li>
          ),
        )}
      </ul>
      {(empty || loadError || actionError) && (
        <div className={`pt-6 ${OVERVIEW_GUTTER}`}>
          {empty && <p className="text-[15px] text-[var(--card-sub)]">{query.trim() ? "No notes match your search." : "No notes yet."}</p>}
          {loadError && (
            <p role="alert" className="text-[15px] text-red-700 dark:text-red-400">
              Couldn&apos;t load notes.{" "}
              <button type="button" onClick={() => void load()} className="min-h-11 font-medium underline sm:min-h-0">
                Try again
              </button>
            </p>
          )}
          {actionError && (
            <p role="alert" className="text-[15px] text-red-700 dark:text-red-400">
              {actionError}
            </p>
          )}
        </div>
      )}
      {open && (
        <NoteDialog
          key={open.id}
          note={open}
          onSaved={(note) => setItems((list) => upsertNote(list ?? [], note))}
          onDeleted={(id) => setItems((list) => (list ? removeNote(list, id) : list))}
          onStarted={(doc) => {
            setOpen(null);
            router.push(`/d/${doc.id}?${OPEN_NOTES_PARAM}=1`);
          }}
          onClosed={() => {
            setOpen(null);
            void load();
          }}
          returnFocus={returnFocus}
        />
      )}
    </div>
  );
}

function DocumentNotesCard({ item, type }: { item: Extract<NotesFeedItem, { kind: "document" }>; type: ReturnType<typeof findType> }) {
  const docTitle = item.document_title.trim();
  return (
    <Link href={`/d/${item.document_id}?${OPEN_NOTES_PARAM}=1`} aria-label={documentNotesName(item.document_title)} className={CARD}>
      <TypeIcon icon={type?.icon} color={type?.color} className="h-8 w-8" />
      <span className={`mt-3 line-clamp-1 text-[19px] font-medium ${docTitle ? "text-[var(--card-title)]" : "text-[var(--card-untitled)]"}`}>{docTitle || "Untitled"}</span>
      <span className="text-[13px] font-medium text-[var(--tab-ink)]">Notes</span>
      {item.title && <span className="mt-1.5 line-clamp-1 text-[14px] font-medium text-[var(--card-sub)]">{item.title}</span>}
      {item.excerpt && <span className="line-clamp-2 text-[14px] text-[var(--card-sub)] sm:line-clamp-1">{item.excerpt}</span>}
    </Link>
  );
}
