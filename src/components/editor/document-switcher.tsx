"use client";

// The "Docs" button: the team's documents, searchable, with a way to start a
// new one. It replaces the old case list as the way to move between documents,
// and is where documents are archived, restored and deleted.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, DocsIcon, FolderOpen, Loader2, Plus, Search, Trash2 } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Summary = { id: string; title: string; excerpt: string; updated_at: string; updated_by: string };

function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function DocumentSwitcher({ currentId }: { currentId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [docs, setDocs] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The row asking "delete this?", and the row with a request running. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    setConfirming(null);
  }, [open, archived]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/documents?q=${encodeURIComponent(query)}${archived ? "&archived=1" : ""}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Couldn't load documents.");
        if (!cancelled) {
          setDocs(body.documents);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load documents.");
      }
    }, query ? 200 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, query, archived]);

  /** Archive, restore or delete a document, then drop it from this list. */
  const act = async (d: Summary, action: "archive" | "unarchive" | "delete") => {
    setWorking(d.id);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(d.id)}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: action === "delete" ? undefined : JSON.stringify({ archived: action === "archive" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Couldn't ${action} this document.`);
      setDocs((list) => list?.filter((x) => x.id !== d.id) ?? null);
      setConfirming(null);
      // Leave an archived or deleted document for a new one. Archiving doesn't
      // move updated_at, so the editor's last edits still save as it unmounts;
      // a restored document stays open and keeps saving.
      if (d.id === currentId && action !== "unarchive") {
        setOpen(false);
        router.push(`/?n=${Date.now()}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn't ${action} this document.`);
    } finally {
      setWorking(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-11 items-center gap-2 rounded-full border-2 border-[var(--doc-accent-line)] px-5 text-[17px] font-semibold text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
        >
          <DocsIcon className="h-5 w-5" /> Docs
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] rounded-xl p-0">
        <div className="flex items-center gap-2 border-b border-[var(--doc-line)] p-3">
          <label htmlFor="doc-search" className="sr-only">
            Search documents
          </label>
          <Search className="h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
          <input
            id="doc-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push(`/?n=${Date.now()}`);
            }}
            className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--doc-accent)] px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}
          {!docs && !error && (
            <p className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
          {docs && docs.length === 0 && (
            <p className="px-4 py-3 text-sm text-[var(--doc-muted)]">
              {query ? "No documents match." : archived ? "No archived documents." : "No documents yet. Start writing and this one is saved here."}
            </p>
          )}
          {docs?.map((d) =>
            confirming === d.id ? (
              <div key={d.id} role="group" aria-label={`Delete ${d.title || "Untitled document"}`} className="flex items-center gap-2 bg-red-50 px-4 py-2.5 dark:bg-red-950/40">
                <p className="min-w-0 flex-1 text-sm">
                  Delete <span className="font-medium">{d.title || "Untitled document"}</span> permanently?
                </p>
                <button
                  type="button"
                  autoFocus
                  disabled={working === d.id}
                  onClick={() => void act(d, "delete")}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {working === d.id && <Loader2 className="h-3 w-3 animate-spin" />} Delete
                </button>
                <button type="button" onClick={() => setConfirming(null)} className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--doc-muted)] hover:text-[var(--doc-ink)]">
                  Cancel
                </button>
              </div>
            ) : (
              <div key={d.id} className={`group flex items-center hover:bg-[var(--doc-accent-soft)] ${d.id === currentId ? "bg-[var(--doc-accent-soft)]" : ""}`}>
                <Link href={`/d/${d.id}`} onClick={() => setOpen(false)} aria-current={d.id === currentId ? "page" : undefined} className="block min-w-0 flex-1 py-2.5 pl-4 pr-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium">{d.title || "Untitled document"}</span>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--doc-muted)]">{when(d.updated_at)}</span>
                  </div>
                  {d.excerpt && <p className="line-clamp-1 text-xs text-[var(--doc-muted)]">{d.excerpt}</p>}
                </Link>
                <div className="flex shrink-0 items-center gap-0.5 pr-2 opacity-100 sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                  <button
                    type="button"
                    disabled={working === d.id}
                    onClick={() => void act(d, archived ? "unarchive" : "archive")}
                    aria-label={archived ? `Restore ${d.title || "Untitled document"}` : `Archive ${d.title || "Untitled document"}`}
                    title={archived ? "Restore" : "Archive"}
                    className="rounded-md p-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-bg)] hover:text-[var(--doc-ink)] disabled:opacity-40"
                  >
                    {working === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    disabled={working === d.id}
                    onClick={() => setConfirming(d.id)}
                    aria-label={`Delete ${d.title || "Untitled document"}`}
                    title="Delete"
                    className="rounded-md p-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-bg)] hover:text-red-600 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--doc-line)] px-3 py-2 text-xs">
          <button type="button" onClick={() => setArchived((a) => !a)} className="flex items-center gap-1 text-[var(--doc-muted)] hover:text-[var(--doc-ink)]">
            <Archive className="h-3.5 w-3.5" /> {archived ? "Show current documents" : "Show archived"}
          </button>
          <Link href="/library" className="flex items-center gap-1 text-[var(--doc-muted)] hover:text-[var(--doc-ink)]">
            <FolderOpen className="h-3.5 w-3.5" /> Source library
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
