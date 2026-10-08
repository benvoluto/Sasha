// Client-side record of background work the user has started, so it stays
// visible after they navigate away, close a panel, or reload the page.
//
// An upload returns as soon as the files are stored; reading and summarizing
// them happens afterwards and takes a while. The sources panel and the library
// only show that while they are on screen, which left the work invisible the
// moment you looked elsewhere — and invisible work gets uploaded twice.
//
// localStorage (not a React atom) specifically so a reload doesn't lose the
// thread. Jobs are removed when every source in them has settled, so the store
// is self-cleaning rather than something the user has to dismiss.

// v2: jobs track sources; v1 tracked legacy upload groups and is ignored.
const KEY = "mk.processingJobs.v2";
const EVENT = "mk:processing-jobs";

/** Give up tracking after this long; the work is either done or stuck. */
export const JOB_MAX_AGE_MS = 20 * 60 * 1000;
/** Past this, warn that it's taking longer than expected. */
export const JOB_SLOW_AFTER_MS = 6 * 60 * 1000;

export type ProcessingJob = {
  /** One upload: a random id, so two uploads to the same place stay separate. */
  id: string;
  /** The sources being read. */
  sourceIds: string[];
  /** Where the files went, e.g. the document's title or "the library". */
  label: string;
  /** File names involved, for a concrete "what am I waiting on". */
  files: string[];
  startedAt: number;
};

function isJob(j: unknown): j is ProcessingJob {
  const job = j as ProcessingJob | null;
  return !!job && typeof job.id === "string" && Array.isArray(job.sourceIds) && job.sourceIds.length > 0 && typeof job.startedAt === "number";
}

function read(): ProcessingJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(isJob).filter((j) => now - j.startedAt < JOB_MAX_AGE_MS);
  } catch {
    return [];
  }
}

function write(jobs: ProcessingJob[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(jobs));
  } catch {
    // Private mode / quota — tracking is best-effort, never fail the upload.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function readJobs(): ProcessingJob[] {
  return read();
}

/** Record a started job. Adding a job with an id already stored replaces it. */
export function addJob(job: Omit<ProcessingJob, "startedAt">): void {
  if (job.sourceIds.length === 0) return;
  const others = read().filter((j) => j.id !== job.id);
  write([...others, { ...job, startedAt: Date.now() }]);
}

export function removeJob(id: string): void {
  write(read().filter((j) => j.id !== id));
}

/** Every source id the stored jobs are waiting on, once each. */
export function trackedSourceIds(jobs: ProcessingJob[]): string[] {
  return [...new Set(jobs.flatMap((j) => j.sourceIds))];
}

const TERMINAL = new Set(["ready", "partial", "error"]);

export type JobOutcome =
  | { settled: false }
  | { settled: true; ready: number; partial: number; failed: number; /** Sources that no longer exist (deleted meanwhile). */ missing: number; error: string | null };

/**
 * Whether a job is finished, given the latest statuses by source id. A source
 * missing from `statuses` was deleted (or belongs to another team now) and
 * counts as settled.
 */
export function jobOutcome(job: ProcessingJob, statuses: Record<string, { extraction_status: string; extraction_error?: string | null }>): JobOutcome {
  let ready = 0;
  let partial = 0;
  let failed = 0;
  let missing = 0;
  let error: string | null = null;
  for (const id of job.sourceIds) {
    const s = statuses[id];
    if (!s) {
      missing++;
      continue;
    }
    if (!TERMINAL.has(s.extraction_status)) return { settled: false };
    if (s.extraction_status === "ready") ready++;
    else if (s.extraction_status === "partial") partial++;
    else {
      failed++;
      error ??= s.extraction_error ?? null;
    }
  }
  return { settled: true, ready, partial, failed, missing, error };
}

/**
 * Subscribe to changes. Covers both this tab (custom event) and other tabs
 * (storage event), so uploading in one tab shows up in another.
 */
export function subscribeJobs(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
