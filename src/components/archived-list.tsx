'use client';

// The Archived view. Archiving is reversible by design, so this screen's job is
// to make restoring easy — and it is the only place a document can be deleted for
// good, which is why destroying one now takes two deliberate steps.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Archive, ArchiveRestore, Calendar, FileText, Loader2, Trash2 } from "@/components/icons";
import type { UploadGroup } from '@/lib/atoms';
import { documentTitle } from '@/lib/case-state';

export function ArchivedList() {
  const [groups, setGroups] = useState<UploadGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/upload-groups?archived=1', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      setGroups(Array.isArray(data.groups) ? data.groups : []);
    } catch {
      setError('Could not load archived documents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const restore = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/upload-groups/${id}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      });
      if (res.ok) await load();
      else setError('Could not restore that document.');
    } finally {
      setBusy(null);
    }
  };

  const destroy = async (group: UploadGroup) => {
    const name = documentTitle(group) || 'this document';
    if (!confirm(`Permanently delete ${name}?\n\nEvery document and every generated artifact goes with it. This cannot be undone.`)) return;
    setBusy(group.id);
    setError(null);
    try {
      const res = await fetch(`/api/upload-groups/${group.id}`, { method: 'DELETE' });
      if (res.ok) await load();
      else setError('Could not delete that document.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <p className="flex items-center gap-2 p-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading archived documents…</p>;
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-white p-12 text-center dark:bg-zinc-900">
        <Archive className="h-8 w-8 text-zinc-300" />
        <p className="text-sm text-zinc-600 dark:text-zinc-300">No archived documents.</p>
        <p className="text-xs text-zinc-400">Archiving a document moves it here instead of deleting it.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {groups.map((group) => (
        <article key={group.id} className="flex items-start justify-between gap-6 rounded-2xl bg-white px-6 py-5 shadow-sm dark:bg-zinc-900">
          <div className="min-w-0">
            <Link href={`/documents/${group.id}`} className="truncate text-xl font-semibold text-zinc-900 hover:underline dark:text-zinc-100">
              {documentTitle(group) || 'Untitled document'}
            </Link>
            <p className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="flex items-center gap-1.5"><FileText className="h-4 w-4" />{group.files.length} source{group.files.length === 1 ? '' : 's'}</span>
              <span className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4" />
                Archived {group.archived?.at ? new Date(group.archived.at).toLocaleDateString() : 'recently'}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => restore(group.id)}
              disabled={busy === group.id}
              className="flex items-center gap-1.5 rounded-full bg-teal-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {busy === group.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
              Restore
            </button>
            <button
              onClick={() => destroy(group)}
              disabled={busy === group.id}
              aria-label={`Delete ${documentTitle(group) || 'document'} permanently`}
              title="Delete permanently"
              className="rounded-full p-2 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
