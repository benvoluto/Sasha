"use client";

// A persistent, self-dismissing indicator for background upload processing.
//
// Mounted once at the app root, so it survives navigating between the document list
// and a document, closing the modal, and full page reloads (jobs live in
// localStorage). It polls a small status endpoint and removes each job when the
// server reports the upload has settled — the user never has to dismiss it, and
// never has to guess whether an upload is still working.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, X } from "@/components/icons";
import { JOB_SLOW_AFTER_MS, readJobs, removeJob, subscribeJobs, type ProcessingJob } from "@/lib/processing-jobs";

const POLL_MS = 4000;
/** How long a finished job stays on screen so the completion is actually seen. */
const DONE_LINGER_MS = 6000;

type Status = { id: string; status: string; fileCount: number; name?: string; error?: string };
type Resolved = { job: ProcessingJob; status: Status; at: number };

export function ProcessingTracker() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  // Finished jobs are pulled out of the store immediately (so a reload doesn't
  // resurrect them) but held here briefly so the user sees the completion.
  const [resolved, setResolved] = useState<Resolved[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => setJobs(readJobs()), []);

  useEffect(() => {
    refresh();
    return subscribeJobs(refresh);
  }, [refresh]);

  // Drive the "taking longer than expected" copy without re-polling.
  useEffect(() => {
    if (jobs.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [jobs.length]);

  const poll = useCallback(async () => {
    const current = readJobs();
    if (current.length === 0) return;
    try {
      const ids = current.map((j) => j.groupId).join(",");
      const res = await fetch(`/api/upload-groups/status?ids=${encodeURIComponent(ids)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { statuses?: Status[] };
      const byId: Record<string, Status> = {};
      for (const s of data.statuses ?? []) byId[s.id] = s;
      setStatuses(byId);

      for (const job of current) {
        const s = byId[job.groupId];
        if (!s || s.status === "processing") continue;
        // Settled (or the document is gone) — stop tracking it.
        removeJob(job.groupId);
        if (s.status !== "unknown") {
          setResolved((prev) => (prev.some((r) => r.job.groupId === job.groupId) ? prev : [...prev, { job, status: s, at: Date.now() }]));
        }
      }
    } catch {
      // Offline or a blip — keep the job and try again next tick.
    }
  }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (jobs.length === 0) return;
    poll();
    pollRef.current = setInterval(poll, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobs.length, poll]);

  // Retire completion notices on their own.
  useEffect(() => {
    if (resolved.length === 0) return;
    const id = setTimeout(() => setResolved((prev) => prev.filter((r) => Date.now() - r.at < DONE_LINGER_MS)), DONE_LINGER_MS);
    return () => clearTimeout(id);
  }, [resolved]);

  if (jobs.length === 0 && resolved.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,22rem)] flex-col gap-2" aria-live="polite">
      {jobs.map((job) => {
        const s = statuses[job.groupId];
        const name = s?.name || job.label || "this document";
        const slow = now - job.startedAt > JOB_SLOW_AFTER_MS;
        return (
          <Card key={job.groupId} groupId={job.groupId} tone="busy">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
            <div className="min-w-0">
              <p className="truncate font-medium text-blue-900 dark:text-blue-200">
                {job.kind === "remove" ? "Updating" : "Processing"} {name}
              </p>
              <p className="text-xs text-blue-800/80 dark:text-blue-300/80">
                {job.files.length > 0
                  ? `${job.files.length} document${job.files.length === 1 ? "" : "s"}: ${job.files.slice(0, 2).join(", ")}${job.files.length > 2 ? "…" : ""}`
                  : "Re-reading the source files"}
              </p>
              <p className="mt-0.5 text-xs text-blue-700/70 dark:text-blue-300/70">
                {slow
                  ? "Taking longer than usual — still working. You don't need to upload again."
                  : "Reading the uploaded files."}
              </p>
            </div>
          </Card>
        );
      })}

      {resolved.map(({ job, status }) => {
        const failed = status.status === "error";
        const name = status.name || job.label || "this document";
        return (
          <Card
            key={`done-${job.groupId}`}
            groupId={job.groupId}
            tone={failed ? "error" : "done"}
            action={
              <button
                onClick={() => setResolved((prev) => prev.filter((r) => r.job.groupId !== job.groupId))}
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            }
          >
            {failed ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
            )}
            <div className="min-w-0">
              <p className={`truncate font-medium ${failed ? "text-red-900 dark:text-red-200" : "text-green-900 dark:text-green-200"}`}>
                {failed ? "Processing failed" : status.status === "partial" ? "Finished with warnings" : "Ready"} — {name}
              </p>
              <p className={`text-xs ${failed ? "text-red-800/80 dark:text-red-300/80" : "text-green-800/80 dark:text-green-300/80"}`}>
                {failed ? status.error || "Some files could not be read." : `${status.fileCount} file${status.fileCount === 1 ? "" : "s"} on the document.`}
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

const TONE = {
  busy: "border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/70",
  done: "border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/70",
  error: "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/70",
};

/** The card body links to the document; `action` sits outside the link so a dismiss
 *  button isn't nested in an anchor (invalid, and it would navigate). */
function Card({ groupId, tone, action, children }: { groupId: string; tone: keyof typeof TONE; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm shadow-lg backdrop-blur ${TONE[tone]}`}>
      <Link href={`/cases/${groupId}`} className="flex min-w-0 flex-1 items-start gap-2.5" title="Open this document">
        {children}
      </Link>
      {action}
    </div>
  );
}
