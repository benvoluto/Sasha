import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for React: refs persist across renders and an effect runs on
// every render whose deps changed, after the previous one's cleanup.
const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, deps: null as unknown[] | null, cleanup: undefined as void | (() => void), i: 0 }));
vi.mock("react", () => ({
  useRef: <T>(current: T) => {
    const i = hooks.i++;
    hooks.refs[i] ??= { current };
    return hooks.refs[i];
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    if (hooks.deps && deps.every((d, i) => Object.is(d, hooks.deps![i]))) return;
    hooks.cleanup?.();
    hooks.deps = deps;
    hooks.cleanup = fn();
  },
}));

import { linkedSourcesKey, SUGGESTIONS_REFRESH_DEBOUNCE_MS, useSuggestionsRefresh } from "./use-suggestions-refresh";

const useRender = (documentId: string | null, typeKey: string | null, notes: string, sources: string | null = null) => {
  hooks.i = 0;
  useSuggestionsRefresh({ documentId, typeKey, notes, sources });
};

describe("useSuggestionsRefresh", () => {
  const fetchMock = vi.fn(async () => new Response("{}"));
  beforeEach(() => {
    hooks.refs = [];
    hooks.deps = null;
    hooks.cleanup = undefined;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("skips the first mount, then debounces type and notes changes into one generate", () => {
    useRender("d1", null, "");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    useRender("d1", "proposal", "");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS - 1);
    useRender("d1", "proposal", "notes");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/documents/d1/suggestions/generate", expect.objectContaining({ method: "POST", body: "{}" })]);
  });

  it("does nothing without a document id, or when switching documents", () => {
    useRender(null, null, "");
    useRender(null, "proposal", "x");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    useRender("d1", "proposal", "x");
    useRender("d2", "memo", "");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores failures", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    useRender("d1", null, "");
    useRender("d1", "proposal", "");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats the first known sources as a baseline, then refreshes when they change", () => {
    const none = linkedSourcesKey([]);
    const one = linkedSourcesKey([{ id: "s1", summary: null }]);
    useRender("d1", "proposal", "");
    useRender("d1", "proposal", "", none);
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    useRender("d1", "proposal", "", one);
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    useRender("d1", "proposal", "", linkedSourcesKey([{ id: "s1", summary: "A quote." }]));
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a pending change when the sources first load mid-debounce", () => {
    useRender("d1", null, "");
    useRender("d1", "proposal", "");
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS - 1);
    useRender("d1", "proposal", "", linkedSourcesKey([]));
    vi.advanceTimersByTime(SUGGESTIONS_REFRESH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys sources by id and summary, ignoring order", () => {
    expect(linkedSourcesKey([{ id: "b", summary: null }, { id: "a", summary: "x" }])).toBe(linkedSourcesKey([{ id: "a", summary: "x" }, { id: "b", summary: null }]));
    expect(linkedSourcesKey([{ id: "a", summary: null }])).not.toBe(linkedSourcesKey([{ id: "a", summary: "x" }]));
  });
});
