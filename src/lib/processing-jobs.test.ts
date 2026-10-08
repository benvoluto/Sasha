import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_MAX_AGE_MS, addJob, jobOutcome, readJobs, removeJob, subscribeJobs, trackedSourceIds } from "./processing-jobs";

const KEY = "mk.processingJobs.v2";

// jsdom isn't configured for this project, so stand up the minimal browser
// surface the store touches.
function installWindow() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn);
    },
    removeEventListener: (t: string, fn: (e: unknown) => void) => listeners.get(t)?.delete(fn),
    dispatchEvent: (e: { type: string }) => {
      listeners.get(e.type)?.forEach((fn) => fn(e));
      return true;
    },
    CustomEvent: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
  };
  (globalThis as unknown as { window: unknown }).window = win;
  (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = win.CustomEvent;
  return { store };
}

let ctx: ReturnType<typeof installWindow>;
beforeEach(() => {
  ctx = installWindow();
});

const job = (id: string, sourceIds = [`${id}-s1`]) => ({ id, sourceIds, label: "Report", files: ["a.pdf"] });

describe("processing job store", () => {
  it("records and reads back a job", () => {
    addJob(job("j1"));
    const jobs = readJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "j1", sourceIds: ["j1-s1"], label: "Report", files: ["a.pdf"] });
    expect(jobs[0].startedAt).toBeGreaterThan(0);
  });

  it("replaces a job stored under the same id", () => {
    addJob(job("j1"));
    addJob({ ...job("j1"), files: ["b.pdf"] });
    const jobs = readJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].files).toEqual(["b.pdf"]);
  });

  it("tracks multiple uploads independently", () => {
    addJob(job("j1"));
    addJob(job("j2"));
    expect(readJobs().map((j) => j.id).sort()).toEqual(["j1", "j2"]);
  });

  it("ignores a job with no sources", () => {
    addJob(job("j1", []));
    expect(readJobs()).toEqual([]);
  });

  it("removes a job when it resolves", () => {
    addJob(job("j1"));
    addJob(job("j2"));
    removeJob("j1");
    expect(readJobs().map((j) => j.id)).toEqual(["j2"]);
  });

  it("expires stale jobs so a stuck upload can't linger forever", () => {
    addJob(job("j1"));
    const raw = JSON.parse(ctx.store.get(KEY)!);
    raw[0].startedAt = Date.now() - JOB_MAX_AGE_MS - 1;
    ctx.store.set(KEY, JSON.stringify(raw));
    expect(readJobs()).toHaveLength(0);
  });

  it("drops malformed entries, including the old upload-group shape", () => {
    ctx.store.set(KEY, JSON.stringify([{ groupId: "g1", label: "x", kind: "upload", files: [], startedAt: Date.now() }, null, { ...job("j1"), startedAt: Date.now() }]));
    expect(readJobs().map((j) => j.id)).toEqual(["j1"]);
  });

  it("survives corrupt storage rather than throwing", () => {
    ctx.store.set(KEY, "{not json");
    expect(readJobs()).toEqual([]);
  });

  it("ignores a non-array payload", () => {
    ctx.store.set(KEY, JSON.stringify({ nope: true }));
    expect(readJobs()).toEqual([]);
  });

  it("lists each tracked source once", () => {
    addJob(job("j1", ["a", "b"]));
    addJob(job("j2", ["b", "c"]));
    expect(trackedSourceIds(readJobs()).sort()).toEqual(["a", "b", "c"]);
  });

  it("notifies subscribers on change", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeJobs(onChange);
    addJob(job("j1"));
    expect(onChange).toHaveBeenCalled();
    unsubscribe();
    addJob(job("j2"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("jobOutcome", () => {
  const j = { ...job("j1", ["a", "b", "c"]), startedAt: 0 };

  it("is unsettled while any source is still being read", () => {
    expect(jobOutcome(j, { a: { extraction_status: "ready" }, b: { extraction_status: "summarizing" }, c: { extraction_status: "error" } })).toEqual({ settled: false });
  });

  it("counts outcomes once every source has settled", () => {
    expect(
      jobOutcome(j, { a: { extraction_status: "ready" }, b: { extraction_status: "partial" }, c: { extraction_status: "error", extraction_error: "Unreadable." } }),
    ).toEqual({ settled: true, ready: 1, partial: 1, failed: 1, missing: 0, error: "Unreadable." });
  });

  it("treats a source that has disappeared as settled", () => {
    expect(jobOutcome(j, { a: { extraction_status: "ready" } })).toEqual({ settled: true, ready: 1, partial: 0, failed: 0, missing: 2, error: null });
  });
});
