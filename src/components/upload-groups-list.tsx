'use client';

// The document list. One card per document, carrying enough to decide whether
// to open it: its title, its status, the sticky-note summary, and its sources.

import React, { useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  uploadGroupsAtom,
  uploadGroupsLoadingAtom,
  uploadGroupsErrorAtom,
  fetchUploadGroupsAtom,
  hasProcessingGroupsAtom,
  startPollingAtom,
  refreshUploadGroupsAtom,
  optimisticallyArchivedAtom,
  type UploadGroup,
} from '@/lib/atoms';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Loader2, AlertCircle, FileText, Sparkles, Search, ArrowUpDown, Pencil, CloudUpload,
  Calendar, ChevronDown, ListFilter, Rows3, LayoutList, FolderOpen, Workflow, Hourglass, PauseCircle,
} from "@/components/icons";
import Link from 'next/link';
import { deriveCaseState, documentTitle, STATE_LABEL, type CaseStateKey } from '@/lib/case-state';
import { AddDocsButton } from './add-docs-button';

// An upload still "processing" past this age has almost certainly stalled (the
// extraction budget is well under a minute), so we surface a recovery hint.
const STALL_AFTER_MS = 7 * 60 * 1000;

type SortKey = 'newest' | 'oldest' | 'name';
const SORT_LABEL: Record<SortKey, string> = { newest: 'Newest first', oldest: 'Oldest first', name: 'Name A–Z' };

interface UploadGroupsListProps {
  refreshTrigger?: number;
  ref?: React.Ref<unknown>;
}

export function UploadGroupsList({ refreshTrigger }: UploadGroupsListProps) {
  const [groups] = useAtom(uploadGroupsAtom);
  const [loading] = useAtom(uploadGroupsLoadingAtom);
  const [error] = useAtom(uploadGroupsErrorAtom);
  const fetchGroups = useSetAtom(fetchUploadGroupsAtom);
  const refreshGroups = useSetAtom(refreshUploadGroupsAtom);
  const hasProcessing = useAtomValue(hasProcessingGroupsAtom);
  const startPolling = useSetAtom(startPollingAtom);
  const [optimisticallyArchived, setOptimisticallyArchived] = useAtom(optimisticallyArchivedAtom);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [dense, setDense] = useState(false);
  // Which cards have their summary expanded past the one-line clamp.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      refreshGroups();
    }
  }, [refreshTrigger, refreshGroups]);

  useEffect(() => {
    if (hasProcessing) startPolling();
  }, [hasProcessing, startPolling]);

  // Once the server stops returning an optimistically-archived document in the
  // active list, the archive is confirmed — drop it from the set so it can't
  // hide the document if it's later restored.
  useEffect(() => {
    if (optimisticallyArchived.length === 0) return;
    const present = new Set(groups.map((g) => g.id));
    const stillPending = optimisticallyArchived.filter((id) => present.has(id));
    if (stillPending.length !== optimisticallyArchived.length) setOptimisticallyArchived(stillPending);
  }, [groups, optimisticallyArchived, setOptimisticallyArchived]);

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const archived = new Set(optimisticallyArchived);
    return groups
      .filter((g) => {
        if (archived.has(g.id)) return false;
        if (stageFilter !== 'all' && deriveCaseState(g).key !== stageFilter) return false;
        if (!q) return true;
        return [documentTitle(g), ...g.files.map((f) => f.name), g.summaryNote?.text]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        if (sort === 'name') return (documentTitle(a) ?? '').localeCompare(documentTitle(b) ?? '');
        const diff = new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime();
        return sort === 'newest' ? diff : -diff;
      });
  }, [groups, query, sort, stageFilter, optimisticallyArchived]);

  if (loading) {
    return (
      <div className="grid gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl bg-white p-6 dark:bg-zinc-900">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="mt-3 h-4 w-72" />
            <Skeleton className="mt-4 h-10 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 dark:bg-red-900/20">
        <p className="text-red-600 dark:text-red-400">Error: {error}</p>
        <button onClick={() => fetchGroups()} className="mt-2 rounded-full border border-red-300 px-3 py-1.5 text-sm text-red-700">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Toolbar
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={setSort}
        stageFilter={stageFilter}
        onStageFilter={setStageFilter}
        dense={dense}
        onDense={setDense}
      />

      {groups.length === 0 ? (
        <p className="p-8 text-center text-sm text-zinc-500">No documents yet. Upload files above to create one.</p>
      ) : visibleGroups.length === 0 ? (
        <p className="p-8 text-center text-sm text-zinc-500">No documents match your search.</p>
      ) : (
        <div className="grid gap-4">
          {visibleGroups.map((group) => {
            const status = deriveCaseState(group);
            const ageMs = Date.now() - new Date(group.geminiProcessing?.processedAt || group.uploadDate).getTime();
            const stalled = group.geminiProcessing?.status === 'processing' && ageMs > STALL_AFTER_MS;
            // A summary of a failed read describes files nobody read; the error banner says what happened.
            const summary = group.geminiProcessing?.status === 'error' ? '' : group.summaryNote?.text || '';
            const isOpen = !!expanded[group.id];
            // While a document's files are being read (not stalled — a stalled
            // upload re-enables its actions so the user can recover), disable
            // the report action.
            const activelyProcessing = group.geminiProcessing?.status === 'processing' && !stalled;
            const title = documentTitle(group) || 'Untitled document';

            return (
              // min-w-0: a grid item defaults to min-width:auto, so the truncating
              // name and summary below set a min-content floor the card can't
              // shrink under — which pushed the whole card past the viewport and
              // took the action column off-screen with it.
              <article key={group.id} className="min-w-0 rounded-2xl bg-white shadow-sm transition-shadow hover:shadow-md dark:bg-zinc-900">
                {(group.geminiProcessing?.status === 'error' || stalled || group.geminiProcessing?.status === 'partial') && (
                  <div className="flex items-start gap-2 rounded-t-2xl border-b border-amber-100 bg-amber-50 px-6 py-2.5 text-xs dark:border-amber-900/40 dark:bg-amber-900/20">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span className="text-amber-800 dark:text-amber-300">
                      {group.geminiProcessing?.status === 'error'
                        ? group.geminiProcessing.error || 'Reading the files failed.'
                        : stalled
                          ? 'Processing is taking longer than expected and may have stalled.'
                          : 'Partial content extracted — some files may not have been fully read.'}
                    </span>
                  </div>
                )}

                <div className={`flex items-start justify-between gap-6 ${dense ? 'px-6 py-4' : 'px-6 py-5'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex w-full flex-wrap items-center gap-2.5">
                      <Link
                        href={`/cases/${group.id}`}
                        className="min-w-0 max-w-full truncate text-[26px] text-zinc-900 hover:text-sky-600 dark:text-zinc-100"
                      >
                        {title}
                      </Link>
                      <span className={`rounded-md px-2.5 py-1 text-sm font-medium ${status.className}`} title={status.detail}>
                        {status.label}
                      </span>
                    </div>

                    {/* The sticky-note summary, same content as the detail rail. */}
                    {status.key === 'extracting' && !summary ? (
                      <p className="mt-3 flex items-center gap-1.5 rounded-md bg-amber-50/70 px-3 py-2 text-[15px] italic text-zinc-500 dark:bg-amber-950/20 dark:text-zinc-400">
                        <Sparkles className="h-4 w-4 shrink-0 animate-pulse text-violet-500" /> Reading the files…
                      </p>
                    ) : summary ? (
                      <button
                        onClick={() => setExpanded((p) => ({ ...p, [group.id]: !p[group.id] }))}
                        className="mt-3 flex w-full items-start gap-2 rounded-md bg-amber-50/70 px-3 py-2 text-left text-[15px] text-zinc-700 hover:bg-amber-50 dark:bg-amber-950/20 dark:text-zinc-300"
                      >
                        <span className={`min-w-0 flex-1 ${isOpen ? 'whitespace-pre-wrap' : 'truncate'}`}>{summary}</span>
                        <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-zinc-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                    ) : null}

                    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[15px]">
                      <span className="flex items-center gap-1.5 text-fuchsia-600 dark:text-fuchsia-400">
                        <FileText className="h-4 w-4" />
                        {group.files.length} {group.files.length === 1 ? 'Source' : 'Sources'}
                      </span>
                      <span className="flex items-center gap-1.5 text-teal-600 dark:text-teal-400">
                        <Calendar className="h-4 w-4" />
                        {formatDate(group.uploadDate)}
                      </span>
                      {group.geminiProcessing?.status === 'processing' && !stalled ? (
                        <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Processing…
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-start gap-3">
                    <AddDocsButton
                      groupId={group.id}
                      documentName={title}
                      onDone={() => refreshGroups()}
                      disabled={activelyProcessing}
                      className="flex items-center gap-2 text-[15px] font-medium text-teal-600 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-teal-400"
                      icon={<CloudUpload className="h-5 w-5" />}
                      label="Upload sources"
                    />
                    <Link
                      href={`/cases/${group.id}`}
                      className="flex items-center gap-2 text-[15px] font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400"
                    >
                      <FolderOpen className="h-5 w-5" />
                      Open document
                    </Link>
                    {group.workflowRun && <WorkflowRunLink groupId={group.id} run={group.workflowRun} />}
                    {activelyProcessing ? (
                      <span
                        aria-disabled="true"
                        title="Available once processing finishes"
                        className="flex cursor-not-allowed items-center gap-2 text-[15px] font-medium text-blue-600/40 dark:text-blue-400/40"
                      >
                        <Pencil className="h-5 w-5" />
                        Edit Report
                      </span>
                    ) : (
                      <Link
                        href={`/cases/${group.id}?mode=report`}
                        className="flex items-center gap-2 text-[15px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
                      >
                        <Pencil className="h-5 w-5" />
                        Edit Report
                      </Link>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

const RUN_LINK: Record<NonNullable<UploadGroup['workflowRun']>['status'], { label: string; title: string }> = {
  running: { label: 'View workflow run', title: 'A workflow is running on this document' },
  awaiting_review: { label: 'Workflow needs review', title: 'The workflow run is waiting at a human checkpoint' },
  paused: { label: 'Workflow paused', title: 'The workflow run paused at its time limit; open it to continue' },
};

/** Opens the workflow editor on this document, where its run shows live on the canvas. */
function WorkflowRunLink({ groupId, run }: { groupId: string; run: NonNullable<UploadGroup['workflowRun']> }) {
  const { label, title } = RUN_LINK[run.status];
  const Icon = run.status === 'awaiting_review' ? Hourglass : run.status === 'paused' ? PauseCircle : Workflow;
  return (
    <Link
      href={`/workflows?source=${encodeURIComponent(groupId)}`}
      title={title}
      className="flex items-center gap-2 text-[15px] font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
    >
      <span className="relative">
        <Icon className="h-5 w-5" />
        {run.status === 'running' && (
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
        )}
      </span>
      {label}
    </Link>
  );
}

function Toolbar({
  query, onQuery, sort, onSort, stageFilter, onStageFilter, dense, onDense,
}: {
  query: string;
  onQuery: (v: string) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  stageFilter: string;
  onStageFilter: (v: string) => void;
  dense: boolean;
  onDense: (v: boolean) => void;
}) {
  const control = 'flex items-center gap-2 rounded-lg bg-zinc-200/70 px-3.5 py-2.5 text-[15px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={() => onDense(true)}
        aria-label="Compact rows"
        aria-pressed={dense}
        className={`grid h-10 w-10 place-items-center rounded-full ${dense ? 'bg-white text-teal-700 shadow-sm dark:bg-zinc-800' : 'text-blue-600 dark:text-blue-400'}`}
      >
        <Rows3 className="h-5 w-5" />
      </button>
      <button
        onClick={() => onDense(false)}
        aria-label="Full rows"
        aria-pressed={!dense}
        className={`grid h-10 w-10 place-items-center rounded-full ${!dense ? 'bg-white text-blue-600 shadow-sm dark:bg-zinc-800' : 'text-blue-600 dark:text-blue-400'}`}
      >
        <LayoutList className="h-5 w-5" />
      </button>

      <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search"
          className="w-full rounded-lg bg-zinc-200/70 py-2.5 pl-10 pr-3 text-[15px] outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-teal-500/40 dark:bg-zinc-800"
        />
      </div>

      <label className={`${control} cursor-pointer`}>
        <ArrowUpDown className="h-4 w-4" />
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          aria-label="Sort documents"
          className="cursor-pointer appearance-none bg-transparent pr-4 outline-none"
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>{SORT_LABEL[k]}</option>
          ))}
        </select>
      </label>

      <label className={`${control} cursor-pointer`}>
        <ListFilter className="h-4 w-4" />
        <select
          value={stageFilter}
          onChange={(e) => onStageFilter(e.target.value)}
          aria-label="Filter by status"
          className="cursor-pointer appearance-none bg-transparent pr-4 outline-none"
        >
          <option value="all">All statuses</option>
          {(Object.keys(STATE_LABEL) as CaseStateKey[]).map((k) => (
            <option key={k} value={k}>{STATE_LABEL[k]}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
