"use client";

// The sources library at /library: every file, link and note the team writes
// from. Folders on the left (each document gets its own the first time a source
// is added to it), the sources in the chosen folder in the middle, and the
// chosen source's details on the right. ?folder= and ?source= keep the place in
// the URL, so the tracker and the editor can link straight to a source;
// ?table= opens one of its tables (a table snapshot's citation link).

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/file-dropzone";
import {
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Loader2,
  MoreVertical,
  NoteIcon,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from "@/components/icons";
import { canHaveTables } from "@/components/editor/data-pane-model";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AddNoteForm,
  AddUrlForm,
  api,
  errorText,
  formatBytes,
  isBusy,
  KindIcon,
  mergeFresh,
  sourceHref,
  sourceTitle,
  StatusChip,
  styles,
  usePollSources,
  when,
  type FolderItem,
  type SourceDetail,
  type SourceKind,
  type SourceSummary,
} from "./shared";
import { SourceTables } from "./source-tables";

/** Which sources the list shows: everything, the unfiled ones, or one folder. */
type FolderFilter = { kind: "all" } | { kind: "root" } | { kind: "folder"; id: string };

function filterFromParam(v: string | null): FolderFilter {
  if (!v) return { kind: "all" };
  if (v === "root") return { kind: "root" };
  return { kind: "folder", id: v };
}

function filterToParam(f: FolderFilter): string | null {
  return f.kind === "all" ? null : f.kind === "root" ? "root" : f.id;
}

type TreeNode = FolderItem & { depth: number };

/** Folders in display order (alphabetical within each parent), with their depth. */
function flattenTree(folders: FolderItem[]): TreeNode[] {
  const byParent = new Map<string | null, FolderItem[]>();
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    const parent = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null;
    (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(f);
  }
  const out: TreeNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const k of kids) {
      out.push({ ...k, depth });
      walk(k.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The folder and everything inside it, which it can't be moved into. */
function descendantsOf(folders: FolderItem[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function SourceLibrary() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = useMemo(() => filterFromParam(params.get("folder")), [params]);
  const selectedId = params.get("source");

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const [folders, setFolders] = useState<FolderItem[] | null>(null);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SourceKind | "">("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"upload" | "url" | "note" | null>(null);

  const loadFolders = useCallback(async () => {
    try {
      const { folders: list } = await api<{ folders: FolderItem[] }>("/api/folders");
      setFolders(list);
    } catch (e) {
      setError(errorText(e, "Couldn't load folders."));
      setFolders((f) => f ?? []);
    }
  }, []);

  const loadSources = useCallback(async () => {
    const qs = new URLSearchParams({ limit: "200" });
    const folderParam = filterToParam(filter);
    if (folderParam) qs.set("folder", folderParam);
    if (query.trim()) qs.set("q", query.trim());
    if (kind) qs.set("kind", kind);
    try {
      const { sources: list } = await api<{ sources: SourceSummary[] }>(`/api/sources?${qs}`);
      setSources(list);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Couldn't load sources."));
      setSources((s) => s ?? []);
    }
  }, [filter, query, kind]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadSources(), query ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [loadSources, query]);

  usePollSources(sources ?? [], (fresh) => setSources((list) => (list ? mergeFresh(list, fresh) : list)));

  const tree = useMemo(() => flattenTree(folders ?? []), [folders]);
  const currentFolder = filter.kind === "folder" ? (folders ?? []).find((f) => f.id === filter.id) : undefined;
  // New sources go into the folder on screen (or the top level).
  const targetFolderId = filter.kind === "folder" ? filter.id : null;
  const heading = filter.kind === "all" ? "All sources" : filter.kind === "root" ? "Not in a folder" : (currentFolder?.name ?? "Folder");

  const onAdded = useCallback(
    (added: SourceSummary[], complete = true) => {
      void loadSources();
      void loadFolders();
      // After a partial upload, keep the dropzone open: it says which files failed.
      if (!complete) return;
      setAdding(null);
      if (added.length === 1) setParams({ source: added[0].id });
    },
    [loadFolders, loadSources, setParams],
  );

  return (
    <div className="doc-screen min-h-screen bg-[var(--doc-bg)] text-[var(--doc-ink)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pb-6 pt-6 sm:px-10 sm:pt-8">
        <div className="flex min-w-0 items-center gap-5">
          <Link href="/" className="text-[22px] font-semibold tracking-tight">
            Sasha
          </Link>
          <nav aria-label="Sections" className="flex items-center gap-1 text-[15px] font-medium">
            <Link href="/" className="rounded-full px-3 py-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)]">
              Write
            </Link>
            <span aria-current="page" className="rounded-full bg-[var(--doc-surface)] px-3 py-1.5 text-[var(--doc-accent)] shadow-sm">
              Sources
            </span>
            <Link href="/workflows" className="rounded-full px-3 py-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)]">
              Workflows
            </Link>
          </nav>
        </div>
        <div className="grid h-11 w-11 place-items-center">
          <UserButton />
        </div>
      </header>

      <main className="mx-2 mb-10 grid min-h-[75vh] overflow-hidden rounded-2xl bg-[var(--doc-surface)] shadow-[0_1px_3px_rgba(16,24,40,0.06),0_8px_24px_rgba(16,24,40,0.05)] sm:mx-10 md:grid-cols-[15rem_1fr] xl:grid-cols-[16rem_1fr_auto]">
        <FolderTree
          folders={folders}
          tree={tree}
          filter={filter}
          onSelect={(f) => setParams({ folder: filterToParam(f), source: null })}
          onChanged={() => {
            void loadFolders();
            void loadSources();
          }}
          onDeleted={(id) => {
            if (filter.kind === "folder" && filter.id === id) setParams({ folder: null });
          }}
        />

        <section aria-label={heading} className="min-w-0 border-t border-[var(--doc-line)] md:border-l md:border-t-0">
          <div className="space-y-3 border-b border-[var(--doc-line)] px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
                {currentFolder?.document_id ? <FileText className="h-5 w-5 shrink-0 text-[var(--doc-muted)]" /> : <FolderOpen className="h-5 w-5 shrink-0 text-[var(--doc-muted)]" />}
                <span className="truncate">{heading}</span>
              </h1>
              <div className="flex flex-wrap items-center gap-1.5">
                {currentFolder?.document_id && (
                  <Link href={`/d/${currentFolder.document_id}`} className="rounded-md px-2.5 py-1.5 text-sm font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]">
                    Open document
                  </Link>
                )}
                <AddButton icon={<UploadCloud className="h-4 w-4" />} label="Upload" active={adding === "upload"} onClick={() => setAdding(adding === "upload" ? null : "upload")} />
                <AddButton icon={<Globe className="h-4 w-4" />} label="Link" active={adding === "url"} onClick={() => setAdding(adding === "url" ? null : "url")} />
                <AddButton icon={<NoteIcon className="h-4 w-4" />} label="Note" active={adding === "note"} onClick={() => setAdding(adding === "note" ? null : "note")} />
              </div>
            </div>
            {adding && (
              <div className="rounded-xl border border-[var(--doc-line)] p-3">
                {adding === "upload" && <FileDropzone folderId={targetFolderId} label={currentFolder?.name ?? "the library"} onUploaded={onAdded} />}
                {adding === "url" && <AddUrlForm idPrefix="library" resolve={async () => ({ folderId: targetFolderId })} onAdded={(s) => onAdded([s])} onCancel={() => setAdding(null)} />}
                {adding === "note" && <AddNoteForm idPrefix="library" resolve={async () => ({ folderId: targetFolderId })} onAdded={(s) => onAdded([s])} onCancel={() => setAdding(null)} />}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--doc-muted)]" aria-hidden />
                <label htmlFor="library-search" className="sr-only">
                  Search sources
                </label>
                <input
                  id="library-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search titles, summaries and text"
                  className={`${styles.field} pl-8`}
                />
              </div>
              <label htmlFor="library-kind" className="sr-only">
                Kind of source
              </label>
              <select id="library-kind" value={kind} onChange={(e) => setKind(e.target.value as SourceKind | "")} className={`${styles.field} w-auto bg-[var(--doc-surface)]`}>
                <option value="">All kinds</option>
                <option value="file">Files</option>
                <option value="url">Links</option>
                <option value="note">Notes</option>
              </select>
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>

          {sources === null ? (
            <p className="flex items-center gap-2 px-6 py-10 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading sources…
            </p>
          ) : sources.length === 0 ? (
            <p className="px-6 py-10 text-sm text-[var(--doc-muted)]">
              {query || kind ? "No sources match." : "Nothing here yet. Upload files, paste a link or write a note to add a source."}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--doc-line)]">
              {sources.map((s) => {
                const active = s.id === selectedId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => setParams({ source: active ? null : s.id, table: null })}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left sm:px-6 ${active ? "bg-[var(--doc-accent-soft)]" : "hover:bg-[var(--doc-accent-soft)]/60"}`}
                    >
                      <KindIcon kind={s.kind} className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{sourceTitle(s)}</span>
                        <span className="mt-0.5 line-clamp-1 text-xs text-[var(--doc-muted)]">
                          {s.summary || [s.filename && s.title ? s.filename : null, formatBytes(s.bytes), when(s.created_at)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <StatusChip status={s.extraction_status} error={s.extraction_error} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selectedId && (
          <SourceDrawer
            key={selectedId}
            id={selectedId}
            focusTableId={params.get("table")}
            folders={tree}
            onClose={() => setParams({ source: null, table: null })}
            onChanged={(s) => {
              setSources((list) => (list ? mergeFresh(list, [s]) : list));
              void loadSources();
            }}
            onDeleted={() => {
              setParams({ source: null, table: null });
              void loadSources();
            }}
          />
        )}
      </main>
    </div>
  );
}

function AddButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium ${
        active ? "border-[var(--doc-accent)] bg-[var(--doc-accent-soft)] text-[var(--doc-accent)]" : "border-[var(--doc-line)] hover:border-[var(--doc-accent-line)] hover:text-[var(--doc-accent)]"
      }`}
    >
      {icon} {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Folder tree

function FolderTree({
  folders,
  tree,
  filter,
  onSelect,
  onChanged,
  onDeleted,
}: {
  folders: FolderItem[] | null;
  tree: TreeNode[];
  filter: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentForNew = filter.kind === "folder" ? filter.id : null;
  const parentName = parentForNew ? tree.find((f) => f.id === parentForNew)?.name : null;

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await run(() => api("/api/folders", { method: "POST", json: { name: name.trim(), parent_id: parentForNew } }), "Couldn't create the folder.");
    if (ok) {
      setName("");
      setCreating(false);
    }
  };

  const item = (active: boolean) =>
    `flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm ${active ? "bg-[var(--doc-accent-soft)] font-medium text-[var(--doc-accent)]" : "hover:bg-[var(--doc-accent-soft)]"}`;

  return (
    <nav aria-label="Folders" className="flex flex-col px-3 py-4">
      <div className="flex items-center justify-between px-2 pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Folders</h2>
        <button
          type="button"
          onClick={() => setCreating((c) => !c)}
          aria-label={parentName ? `New folder in ${parentName}` : "New folder"}
          title={parentName ? `New folder in ${parentName}` : "New folder"}
          className="rounded-md p-1 text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
      </div>
      {creating && (
        <form onSubmit={create} className="mb-2 space-y-1.5 px-2">
          <label htmlFor="new-folder" className="block text-xs text-[var(--doc-muted)]">
            {parentName ? `New folder in ${parentName}` : "New folder"}
          </label>
          <input
            id="new-folder"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            className={styles.field}
          />
          <div className="flex gap-1.5">
            <button type="submit" disabled={busy || !name.trim()} className={styles.primary}>
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)} className={styles.quiet}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ul className="space-y-0.5">
        <li className="flex">
          <button type="button" onClick={() => onSelect({ kind: "all" })} aria-current={filter.kind === "all" ? "true" : undefined} className={`${item(filter.kind === "all")} pl-2`}>
            <FolderOpen className="h-4 w-4 shrink-0" /> All sources
          </button>
        </li>
        <li className="flex">
          <button type="button" onClick={() => onSelect({ kind: "root" })} aria-current={filter.kind === "root" ? "true" : undefined} className={`${item(filter.kind === "root")} pl-2`}>
            <Folder className="h-4 w-4 shrink-0" /> Not in a folder
          </button>
        </li>
        {folders === null && (
          <li className="flex items-center gap-2 px-2 py-1.5 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </li>
        )}
        {tree.map((f) => {
          const active = filter.kind === "folder" && filter.id === f.id;
          const indent = { paddingLeft: `${0.5 + (f.depth + 1) * 0.85}rem` };
          if (renaming === f.id) {
            return (
              <li key={f.id}>
                <RenameForm
                  initial={f.name}
                  busy={busy}
                  onCancel={() => setRenaming(null)}
                  onSave={async (n) => {
                    if (await run(() => api(`/api/folders/${f.id}`, { method: "PATCH", json: { name: n } }), "Couldn't rename the folder.")) setRenaming(null);
                  }}
                />
              </li>
            );
          }
          return (
            <li key={f.id}>
              <div className="group flex items-center">
                <button type="button" onClick={() => onSelect({ kind: "folder", id: f.id })} aria-current={active ? "true" : undefined} style={indent} className={item(active)}>
                  {f.document_id ? <FileText className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
                  <span className="truncate">{f.name}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${f.name}`}
                      className="rounded-md p-1 text-[var(--doc-muted)] opacity-60 hover:bg-[var(--doc-accent-soft)] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(f.id)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setMoving(f.id)}>Move…</DropdownMenuItem>
                    {f.document_id && (
                      <DropdownMenuItem asChild>
                        <Link href={`/d/${f.document_id}`}>Open document</Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setConfirming(f.id)} className="text-red-600 focus:text-red-700 dark:text-red-400">
                      Delete…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {moving === f.id && folders && (
                <MoveFolderForm
                  folder={f}
                  folders={folders}
                  tree={tree}
                  busy={busy}
                  onCancel={() => setMoving(null)}
                  onMove={async (parent) => {
                    if (await run(() => api(`/api/folders/${f.id}`, { method: "PATCH", json: { parent_id: parent } }), "Couldn't move the folder.")) setMoving(null);
                  }}
                />
              )}
              {confirming === f.id && (
                <div role="alertdialog" aria-label={`Delete ${f.name}?`} className="mx-2 my-1 space-y-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100">
                  <p>Delete “{f.name}” and its subfolders? The sources inside move to “Not in a folder”.</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      autoFocus
                      disabled={busy}
                      onClick={async () => {
                        if (await run(() => api(`/api/folders/${f.id}`, { method: "DELETE" }), "Couldn't delete the folder.")) {
                          setConfirming(null);
                          onDeleted(f.id);
                        }
                      }}
                      className="rounded-md bg-red-700 px-2.5 py-1 font-semibold text-white disabled:opacity-50"
                    >
                      Delete folder
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="rounded-md px-2 py-1">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-2 px-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </nav>
  );
}

function RenameForm({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
      className="space-y-1.5 px-2 py-1"
    >
      <label className="sr-only" htmlFor="rename-folder">
        Folder name
      </label>
      <input id="rename-folder" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} className={styles.field} />
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !name.trim()} className={styles.primary}>
          Save
        </button>
        <button type="button" onClick={onCancel} className={styles.quiet}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function MoveFolderForm({
  folder,
  folders,
  tree,
  busy,
  onMove,
  onCancel,
}: {
  folder: FolderItem;
  folders: FolderItem[];
  tree: TreeNode[];
  busy: boolean;
  onMove: (parent: string | null) => void;
  onCancel: () => void;
}) {
  const blocked = useMemo(() => descendantsOf(folders, folder.id), [folders, folder.id]);
  const [dest, setDest] = useState(folder.parent_id ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onMove(dest || null);
      }}
      className="mx-2 my-1 space-y-1.5 rounded-lg border border-[var(--doc-line)] p-2.5"
    >
      <label htmlFor={`move-${folder.id}`} className="block text-xs text-[var(--doc-muted)]">
        Move “{folder.name}” into
      </label>
      <select id={`move-${folder.id}`} autoFocus value={dest} onChange={(e) => setDest(e.target.value)} className={`${styles.field} bg-[var(--doc-surface)]`}>
        <option value="">Top level</option>
        {tree
          .filter((f) => !blocked.has(f.id))
          .map((f) => (
            <option key={f.id} value={f.id}>
              {"  ".repeat(f.depth)}
              {f.name}
            </option>
          ))}
      </select>
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || dest === (folder.parent_id ?? "")} className={styles.primary}>
          Move
        </button>
        <button type="button" onClick={onCancel} className={styles.quiet}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Source details

type DocRef = { id: string; title: string };

function SourceDrawer({
  id,
  focusTableId,
  folders,
  onClose,
  onChanged,
  onDeleted,
}: {
  id: string;
  /** ?table=: the table to scroll to and expand in the Tables section (a snapshot's citation link). */
  focusTableId: string | null;
  folders: TreeNode[];
  onClose: () => void;
  onChanged: (s: SourceSummary) => void;
  onDeleted: () => void;
}) {
  const [source, setSource] = useState<SourceDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    try {
      const { source: s } = await api<{ source: SourceDetail }>(`/api/sources/${encodeURIComponent(id)}`);
      setSource(s);
      setError(null);
    } catch (e) {
      setMissing(true);
      setError(errorText(e, "Source not found."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // While it's being read, keep the details (summary, text, status) current.
  usePollSources(source ? [source] : [], () => void load());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && !e.defaultPrevented && !t?.closest("input, textarea, select, [role=menu]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Titles for the linked documents.
  const docIds = source?.document_ids.join(",") ?? "";
  useEffect(() => {
    if (!docIds) return;
    let cancelled = false;
    void Promise.all(
      docIds.split(",").map(async (d) => {
        try {
          const { document } = await api<{ document: { title: string } }>(`/api/documents/${encodeURIComponent(d)}`);
          return [d, document.title || "Untitled document"] as const;
        } catch {
          return [d, "Untitled document"] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setDocs(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [docIds]);

  const act = async (label: string, fn: () => Promise<void>, fallback: string) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const patch = (body: { title?: string | null; folder_id?: string | null }) =>
    act(
      "patch",
      async () => {
        const { source: s } = await api<{ source: SourceSummary }>(`/api/sources/${encodeURIComponent(id)}`, { method: "PATCH", json: body });
        setSource((prev) => (prev ? { ...prev, ...s } : prev));
        onChanged(s);
      },
      "Couldn't save the change.",
    );

  const retry = () =>
    act(
      "retry",
      async () => {
        const { source: s } = await api<{ source: SourceSummary }>(`/api/sources/${encodeURIComponent(id)}/retry`, { method: "POST" });
        setSource((prev) => (prev ? { ...prev, ...s } : prev));
        onChanged(s);
      },
      "Couldn't start reading it again.",
    );

  const remove = () =>
    act(
      "delete",
      async () => {
        await api(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
        onDeleted();
      },
      "Couldn't delete the source.",
    );

  const linkTo = (doc: DocRef) =>
    act(
      "link",
      async () => {
        await api(`/api/documents/${encodeURIComponent(doc.id)}/sources`, { method: "POST", json: { source_id: id } });
        setDocs((d) => ({ ...d, [doc.id]: doc.title || "Untitled document" }));
        await load();
      },
      "Couldn't link the source.",
    );

  const unlinkFrom = (docId: string) =>
    act(
      `unlink:${docId}`,
      async () => {
        await api(`/api/documents/${encodeURIComponent(docId)}/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
        await load();
      },
      "Couldn't remove the link.",
    );

  const href = source ? sourceHref(source) : null;
  const status = source?.extraction_status;
  const canRetry = status === "error" || status === "partial" || status === "ready";

  return (
    <aside
      aria-label="Source details"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(28rem,100vw)] flex-col border-l border-[var(--doc-line)] bg-[var(--doc-surface)] shadow-2xl xl:static xl:z-auto xl:w-[26rem] xl:shadow-none"
    >
      <div className="flex items-center justify-between px-5 pb-2 pt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Source</h2>
        <button type="button" onClick={onClose} aria-label="Close source details" className="rounded-md p-1 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!source ? (
        <div className="px-5 py-6 text-sm text-[var(--doc-muted)]">
          {missing ? (
            <p role="alert">{error ?? "Source not found."}</p>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 space-y-5 overflow-y-auto px-5 pb-8">
          <div className="space-y-2">
            {editingTitle ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setEditingTitle(false);
                  void patch({ title: title.trim() || null });
                }}
                className="space-y-1.5"
              >
                <label htmlFor="source-title" className="sr-only">
                  Title
                </label>
                <input id="source-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditingTitle(false)} className={styles.field} />
                <div className="flex gap-1.5">
                  <button type="submit" className={styles.primary}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingTitle(false)} className={styles.quiet}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <h3 className="flex items-start gap-2 text-lg font-semibold leading-snug">
                <KindIcon kind={source.kind} className="mt-1 h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                <button
                  type="button"
                  onClick={() => {
                    setTitle(source.title ?? sourceTitle(source));
                    setEditingTitle(true);
                  }}
                  title="Rename"
                  className="min-w-0 break-words text-left hover:text-[var(--doc-accent)]"
                >
                  {sourceTitle(source)}
                </button>
              </h3>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--doc-muted)]">
              <StatusChip status={source.extraction_status} error={source.extraction_error} />
              {source.filename && source.title && <span className="truncate">{source.filename}</span>}
              {source.bytes ? <span>{formatBytes(source.bytes)}</span> : null}
              <span>Added {when(source.created_at)}</span>
            </div>
            {source.extraction_error && (status === "error" || status === "partial") && <p className="text-sm text-red-700 dark:text-red-300">{source.extraction_error}</p>}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {href && (
                <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-md border border-[var(--doc-line)] px-2.5 py-1.5 text-sm font-medium text-[var(--doc-accent)] hover:border-[var(--doc-accent-line)]">
                  <ExternalLink className="h-4 w-4" /> {source.kind === "url" ? "Open page" : "Open file"}
                </a>
              )}
              {canRetry && (
                <button type="button" onClick={() => void retry()} disabled={!!busy} className="flex items-center gap-1.5 rounded-md border border-[var(--doc-line)] px-2.5 py-1.5 text-sm font-medium hover:border-[var(--doc-accent-line)] disabled:opacity-50">
                  {busy === "retry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Read again
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={!!busy}
                className="flex items-center gap-1.5 rounded-md border border-[var(--doc-line)] px-2.5 py-1.5 text-sm font-medium text-red-700 hover:border-red-300 disabled:opacity-50 dark:text-red-300"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>
            {confirmDelete && (
              <div role="alertdialog" aria-label="Delete this source?" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100">
                <p>
                  Delete this source{source.document_ids.length ? ` and remove it from ${source.document_ids.length} document${source.document_ids.length === 1 ? "" : "s"}` : ""}? This can&apos;t be undone.
                </p>
                <div className="flex gap-1.5">
                  <button type="button" autoFocus onClick={() => void remove()} disabled={!!busy} className="flex items-center gap-1.5 rounded-md bg-red-700 px-3 py-1.5 font-semibold text-white disabled:opacity-50">
                    {busy === "delete" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Delete source
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md px-2 py-1.5">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>

          <section className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Summary</h4>
            <p className="text-sm leading-relaxed">
              {source.summary ?? (status === "ready" || status === "partial" ? "No summary." : status === "error" ? "Not available." : "Appears once the source has been read.")}
            </p>
          </section>

          <SourceTables sourceId={source.id} canHave={canHaveTables(source)} busy={isBusy(source)} status={source.extraction_status} focusTableId={focusTableId} />

          <section className="space-y-1.5">
            <label htmlFor="source-folder" className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">
              Folder
            </label>
            <select
              id="source-folder"
              value={source.folder_id ?? ""}
              disabled={busy === "patch"}
              onChange={(e) => void patch({ folder_id: e.target.value || null })}
              className={`${styles.field} bg-[var(--doc-surface)]`}
            >
              <option value="">Not in a folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {"  ".repeat(f.depth)}
                  {f.name}
                </option>
              ))}
            </select>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Used in</h4>
            {source.document_ids.length === 0 ? (
              <p className="text-sm text-[var(--doc-muted)]">Not linked to any document.</p>
            ) : (
              <ul className="space-y-1">
                {source.document_ids.map((d) => (
                  <li key={d} className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                    <Link href={`/d/${d}`} className="min-w-0 flex-1 truncate text-[var(--doc-accent)] hover:underline">
                      {docs[d] ?? "…"}
                    </Link>
                    <button
                      type="button"
                      onClick={() => void unlinkFrom(d)}
                      disabled={!!busy}
                      aria-label={`Remove from ${docs[d] ?? "document"}`}
                      title="Remove from this document"
                      className="rounded-md p-1 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-50"
                    >
                      {busy === `unlink:${d}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <LinkToDocument exclude={source.document_ids} busy={busy === "link"} onPick={(doc) => void linkTo(doc)} />
          </section>

          <section className="space-y-1.5">
            <details className="group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">
                Extracted text{source.extracted_text ? ` (${source.extracted_text.length.toLocaleString()} characters)` : ""}
              </summary>
              {source.extracted_text ? (
                <pre className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--doc-accent-soft)] p-3 font-sans text-xs leading-relaxed">
                  {source.extracted_text}
                </pre>
              ) : (
                <p className="mt-2 text-sm text-[var(--doc-muted)]">No text yet.</p>
              )}
            </details>
          </section>
        </div>
      )}
    </aside>
  );
}

/** Search the team's documents and link the source to one. */
function LinkToDocument({ exclude, busy, onPick }: { exclude: string[]; busy: boolean; onPick: (doc: DocRef) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocRef[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = window.setTimeout(
      async () => {
        try {
          const { documents } = await api<{ documents: DocRef[] }>(`/api/documents?q=${encodeURIComponent(query.trim())}`);
          if (!cancelled) setResults(documents);
        } catch {
          if (!cancelled) setResults([]);
        }
      },
      query ? 200 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, query]);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-[var(--doc-accent)] hover:underline">
        Link to a document…
      </button>
    );
  }
  const shown = (results ?? []).filter((d) => !exclude.includes(d.id)).slice(0, 8);
  return (
    <div className="space-y-1.5 rounded-lg border border-[var(--doc-line)] p-2.5">
      <label htmlFor="link-doc-search" className="block text-xs text-[var(--doc-muted)]">
        Link to document
      </label>
      <input
        id="link-doc-search"
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="Search documents"
        className={styles.field}
      />
      {results === null ? (
        <p className="flex items-center gap-2 py-1 text-xs text-[var(--doc-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : shown.length === 0 ? (
        <p className="py-1 text-xs text-[var(--doc-muted)]">No documents found.</p>
      ) : (
        <ul className="max-h-48 overflow-y-auto">
          {shown.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onPick(d);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--doc-accent-soft)] disabled:opacity-50"
              >
                <FileText className="h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                <span className="truncate">{d.title || "Untitled document"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => setOpen(false)} className={styles.quiet}>
        Cancel
      </button>
    </div>
  );
}
