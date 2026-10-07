import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_MAX_AGE_MS, addJob, readJobs, removeJob, subscribeJobs } from "./processing-jobs";

const KEY = "mk.processingJobs.v1";

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

const job = (groupId: string) => ({ groupId, label: "Mason", kind: "upload" as const, files: ["a.pdf"] });

describe("processing job store", () => {
  it("records and reads back a job", () => {
    addJob(job("g1"));
    const jobs = readJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ groupId: "g1", label: "Mason", kind: "upload", files: ["a.pdf"] });
    expect(jobs[0].startedAt).toBeGreaterThan(0);
  });

  it("keeps one job per case — a second upload replaces the first", () => {
    addJob(job("g1"));
    addJob({ ...job("g1"), files: ["b.pdf"] });
    const jobs = readJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].files).toEqual(["b.pdf"]);
  });

  it("tracks multiple cases independently", () => {
    addJob(job("g1"));
    addJob(job("g2"));
    expect(readJobs().map((j) => j.groupId).sort()).toEqual(["g1", "g2"]);
  });

  it("removes a job when it resolves", () => {
    addJob(job("g1"));
    addJob(job("g2"));
    removeJob("g1");
    expect(readJobs().map((j) => j.groupId)).toEqual(["g2"]);
  });

  it("expires stale jobs so a stuck case can't linger forever", () => {
    addJob(job("g1"));
    const raw = JSON.parse(ctx.store.get(KEY)!);
    raw[0].startedAt = Date.now() - JOB_MAX_AGE_MS - 1;
    ctx.store.set(KEY, JSON.stringify(raw));
    expect(readJobs()).toHaveLength(0);
  });

  it("survives corrupt storage rather than throwing", () => {
    ctx.store.set(KEY, "{not json");
    expect(readJobs()).toEqual([]);
  });

  it("ignores a non-array payload", () => {
    ctx.store.set(KEY, JSON.stringify({ nope: true }));
    expect(readJobs()).toEqual([]);
  });

  it("notifies subscribers on change", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeJobs(onChange);
    addJob(job("g1"));
    expect(onChange).toHaveBeenCalled();
    unsubscribe();
    addJob(job("g2"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
