"use client";

// A persistent, self-dismissing indicator for sources being read in the
// background.
//
// Mounted once at the app root, so it survives navigating between documents and
// the library and full page reloads (jobs live in localStorage). It polls the
// sources being read and removes each job once all of its sources have settled —
// the user never has to dismiss it, and never has to guess whether an upload is
// still working.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, X } from "@/components/icons";
import { JOB_SLOW_AFTER_MS, jobOutcome, readJobs, removeJob, subscribeJobs, trackedSourceIds, type JobOutcome, type ProcessingJob } from "@/lib/processing-jobs";

const POLL_MS = 4000;
/** How long a finished job stays on screen so the completion is actually seen. */
const DONE_LINGER_MS = 6000;

type Status = { id: string; extraction_status: string; extraction_error: string | null };
type Resolved = { job: ProcessingJob; outcome: Extract<JobOutcome, { settled: true }>; at: number };

export function ProcessingTracker() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
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
      const ids = trackedSourceIds(current).join(",");
      const res = await fetch(`/api/sources?ids=${encodeURIComponent(ids)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sources?: Status[] };
      const byId: Record<string, Status> = {};
      for (const s of data.sources ?? []) byId[s.id] = s;

      for (const job of current) {
        const outcome = jobOutcome(job, byId);
        if (!outcome.settled) continue;
        removeJob(job.id);
        // Everything deleted meanwhile: nothing worth announcing.
        if (outcome.missing === job.sourceIds.length) continue;
        setResolved((prev) => (prev.some((r) => r.job.id === job.id) ? prev : [...prev, { job, outcome, at: Date.now() }]));
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

  const fileList = (files: string[]) =>
    files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 2).join(", ")}${files.length > 2 ? "…" : ""}` : "";

  return (
    <div className="pointer-events-none fixed bottom-[calc(var(--fab-clearance,0px)+1rem)] right-4 z-[60] flex w-[min(92vw,22rem)] flex-col gap-2" aria-live="polite">
      {jobs.map((job) => {
        const slow = now - job.startedAt > JOB_SLOW_AFTER_MS;
        return (
          <Card key={job.id} sourceId={job.sourceIds[0]} tone="busy">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
            <div className="min-w-0">
              <p className="truncate font-medium text-blue-900 dark:text-blue-200">Reading sources for {job.label}</p>
              {job.files.length > 0 && <p className="text-xs text-blue-800/80 dark:text-blue-300/80">{fileList(job.files)}</p>}
              <p className="mt-0.5 text-xs text-blue-700/70 dark:text-blue-300/70">
                {slow ? "Taking longer than usual — still working. You don't need to upload again." : "Reading and summarizing the uploaded files."}
              </p>
            </div>
          </Card>
        );
      })}

      {resolved.map(({ job, outcome }) => {
        const failed = outcome.failed > 0;
        const settled = outcome.ready + outcome.partial + outcome.failed;
        return (
          <Card
            key={`done-${job.id}`}
            sourceId={job.sourceIds[0]}
            tone={failed ? "error" : "done"}
            action={
              <button
                type="button"
                onClick={() => setResolved((prev) => prev.filter((r) => r.job.id !== job.id))}
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
                {failed ? (outcome.failed === settled ? "Couldn't read the sources" : "Some sources couldn't be read") : outcome.partial ? "Read with warnings" : "Sources ready"} — {job.label}
              </p>
              <p className={`text-xs ${failed ? "text-red-800/80 dark:text-red-300/80" : "text-green-800/80 dark:text-green-300/80"}`}>
                {failed ? outcome.error || "Open the library to retry." : `${settled} source${settled === 1 ? "" : "s"} read.`}
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

/** The card body links to the source in the library; `action` sits outside the
 *  link so a dismiss button isn't nested in an anchor (invalid, and it would navigate). */
function Card({ sourceId, tone, action, children }: { sourceId: string; tone: keyof typeof TONE; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm shadow-lg backdrop-blur ${TONE[tone]}`}>
      <Link href={`/library?source=${encodeURIComponent(sourceId)}`} className="flex min-w-0 flex-1 items-start gap-2.5" title="Open in the library">
        {children}
      </Link>
      {action}
    </div>
  );
}
