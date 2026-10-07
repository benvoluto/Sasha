// Client-side record of background work the user has started, so it stays
// visible after they navigate away, close the case modal, or reload the page.
//
// Uploading returns as soon as the files are stored; reading them, extracting
// scores, and re-running the governed review happen afterwards and take a while.
// The in-case banner only exists while that case is on screen, which left the
// work invisible the moment you looked elsewhere — and invisible work gets
// uploaded twice.
//
// localStorage (not a React atom) specifically so a reload doesn't lose the
// thread. Jobs are removed when the server reports the case has settled, so the
// store is self-cleaning rather than something the user has to dismiss.

const KEY = "mk.processingJobs.v1";
const EVENT = "mk:processing-jobs";

/** Give up tracking after this long; the work is either done or stuck. */
export const JOB_MAX_AGE_MS = 20 * 60 * 1000;
/** Past this, warn that it's taking longer than expected. */
export const JOB_SLOW_AFTER_MS = 6 * 60 * 1000;

export type ProcessingJob = {
  /** Upload group being processed. */
  groupId: string;
  /** Best-known case name at the time the job started (server name wins later). */
  label: string;
  /** What the user did — shapes the wording, not the behaviour. */
  kind: "upload" | "remove";
  /** File names involved, for a concrete "what am I waiting on". */
  files: string[];
  startedAt: number;
};

function read(): ProcessingJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as ProcessingJob[]).filter((j) => j && typeof j.groupId === "string" && now - j.startedAt < JOB_MAX_AGE_MS);
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

/** Record a started job. One per case: a second upload replaces the first entry. */
export function addJob(job: Omit<ProcessingJob, "startedAt">): void {
  const others = read().filter((j) => j.groupId !== job.groupId);
  write([...others, { ...job, startedAt: Date.now() }]);
}

export function removeJob(groupId: string): void {
  write(read().filter((j) => j.groupId !== groupId));
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
