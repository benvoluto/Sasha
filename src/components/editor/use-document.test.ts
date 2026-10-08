import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for React's hooks, so useDocument can run as a plain function.
// State setters are recorded but don't re-render, like a render that hasn't
// happened yet (React runs a fetch-triggered render in a later task); call
// render() again to see the next render's values. Refs persist across renders.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock("react", () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = hooks.i++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (v: T | ((prev: T) => T)) => {
      hooks.slots[i] = typeof v === "function" ? (v as (prev: T) => T)(hooks.slots[i] as T) : v;
    };
    return [hooks.slots[i], set];
  },
  useRef: <T>(current: T) => {
    const i = hooks.i++;
    if (!(i in hooks.slots)) hooks.slots[i] = { current };
    return hooks.slots[i];
  },
  useCallback: <T>(fn: T) => fn,
  useEffect: () => {},
}));

import { fitsKeepalive, saveRetryDelay, useDocument } from "./use-document";

/** One render of the hook (the first one mounts it). */
function render(id: string | null) {
  hooks.i = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React is mocked above; this is a plain call.
  return useDocument(id);
}

beforeEach(() => {
  hooks.slots = [];
  hooks.i = 0;
});

describe("saveRetryDelay", () => {
  it("never retries a 4xx on its own", () => {
    for (const status of [400, 403, 404, 409, 413, 429]) expect(saveRetryDelay(status, 0)).toBeNull();
  });

  it("backs off exponentially for network and server failures, capped at 30s", () => {
    expect(saveRetryDelay(null, 0)).toBe(1200);
    expect(saveRetryDelay(503, 1)).toBe(2400);
    expect(saveRetryDelay(500, 3)).toBe(9600);
    expect(saveRetryDelay(null, 10)).toBe(30_000);
  });
});

describe("fitsKeepalive", () => {
  it("allows bodies under the browser's keepalive limit only", () => {
    expect(fitsKeepalive("x".repeat(59_000))).toBe(true);
    expect(fitsKeepalive("x".repeat(70_000))).toBe(false);
    // Counted in bytes, not characters.
    expect(fitsKeepalive("é".repeat(40_000))).toBe(false);
  });
});

describe("useDocument flush", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves to a new document's id as soon as the save returns, before any re-render", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/d/new", search: "" },
      history: { replaceState: vi.fn() },
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ document: { id: "doc-1", updated_at: "2026-01-01T00:00:00.000Z" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const hook = render(null);
    hook.change({ title: "Plan" });
    expect(await hook.flush()).toBe("doc-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/documents", expect.objectContaining({ method: "POST" }));
    // The state the caller holds is still the pre-save render's.
    expect(hook.doc.id).toBeNull();
    // Nothing pending: still the id.
    expect(await hook.flush()).toBe("doc-1");
  });

  it("resolves to null when the document still doesn't exist", async () => {
    vi.stubGlobal("window", { location: { pathname: "/d/new", search: "" }, history: { replaceState: vi.fn() }, setTimeout: () => 1, clearTimeout: () => {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })));
    const hook = render(null);
    hook.change({ title: "Plan" });
    expect(await hook.flush()).toBeNull();
  });
});


const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

function stubWindow() {
  vi.stubGlobal("window", { location: { pathname: "/d/new", search: "" }, history: { replaceState: vi.fn() }, setTimeout: () => 1, clearTimeout: () => {} });
}

/** A fetch that answers each call with the next reply and records the requests. */
function replies(...list: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
    const next = list.shift();
    if (!next) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const saved = (updated_at: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { document: { id: "doc-1", updated_at, ...extra } } });
const created = { status: 201, body: { document: { id: "doc-1", updated_at: T0 } } };

/** A hook whose new document has been created (so later saves are PATCHes based on T0). */
async function savedHook(calls: ReturnType<typeof replies>) {
  const hook = render(null);
  hook.change({ title: "Plan" });
  await hook.flush();
  calls.length = 0;
  return hook;
}

describe("useDocument notes", () => {
  beforeEach(stubWindow);
  afterEach(() => vi.unstubAllGlobals());

  it("saves notes with a PATCH carrying the version they were based on", async () => {
    const calls = replies(created, saved(T1));
    const hook = await savedHook(calls);
    hook.change({ notes: "For the library board." });
    await hook.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/documents/doc-1", method: "PATCH", body: { notes: "For the library board.", base_updated_at: T0, force: false } });
  });

  it("sends notes and body edits made together in one PATCH", async () => {
    const calls = replies(created, saved(T1));
    const hook = await savedHook(calls);
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };
    hook.change({ content_json: body });
    hook.change({ notes: "Cover the budget." });
    hook.change({ title: "Plan v2" });
    await hook.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ content_json: body, notes: "Cover the budget.", title: "Plan v2", base_updated_at: T0, force: false });
  });

  it("keeps notes pending through a conflict, and Keep mine resends them over the newer version", async () => {
    const theirs = { id: "doc-1", title: "Their plan", type_key: null, content_json: null, notes: "their notes", updated_at: T1 };
    const calls = replies(created, { status: 409, body: { error: "changed", document: theirs } }, saved(T2));
    const hook = await savedHook(calls);
    hook.change({ notes: "my notes" });
    await hook.flush();
    // Nothing was lost: the next render sees the conflict, and "Keep mine" sends the notes again.
    const next = render(null);
    expect(next.status).toBe("conflict");
    expect(next.conflict).toMatchObject({ notes: "their notes", updated_at: T1 });
    await next.resolveConflict("mine");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ notes: "my notes", title: "Plan", base_updated_at: T1, force: true });
    expect(render(null).status).toBe("saved");
  });

  it("Load their version drops the pending notes", async () => {
    const theirs = { id: "doc-1", title: "Plan", type_key: null, content_json: null, notes: "their notes", updated_at: T1 };
    const calls = replies(created, { status: 409, body: { error: "changed", document: theirs } });
    const hook = await savedHook(calls);
    hook.change({ notes: "my notes" });
    await hook.flush();
    await render(null).resolveConflict("theirs");
    expect(render(null).doc.notes).toBe("their notes");
    // Nothing left to send.
    await render(null).flush();
    expect(calls).toHaveLength(1);
  });

  it("sends notes typed before a new document's first save in the PATCH that follows", async () => {
    const calls = replies(created, saved(T1));
    const hook = render(null);
    hook.change({ notes: "Who it's for: the board." });
    expect(await hook.flush()).toBe("doc-1");
    // POST /api/documents takes no notes.
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).not.toHaveProperty("notes");
    // They are queued again, so the document isn't shown as saved yet.
    expect(render(null).status).toBe("saving");
    await hook.flush();
    expect(calls[1]).toMatchObject({ url: "/api/documents/doc-1", method: "PATCH", body: { notes: "Who it's for: the board.", base_updated_at: T0 } });
  });

  it("notes alone make a new document worth creating", async () => {
    replies(created);
    const hook = render(null);
    const setTimeoutSpy = vi.fn(() => 1);
    vi.stubGlobal("window", { location: { pathname: "/d/new", search: "" }, history: { replaceState: vi.fn() }, setTimeout: setTimeoutSpy, clearTimeout: () => {} });
    hook.change({ notes: "   " });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    hook.change({ notes: "Budget first." });
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe("useDocument type_source", () => {
  beforeEach(stubWindow);
  afterEach(() => vi.unstubAllGlobals());

  it("sends type_source classifier with the type_key the chip applied", async () => {
    const calls = replies(created, saved(T1), saved(T2));
    const hook = await savedHook(calls);
    hook.change({ type_key: "proposal", type_source: "classifier" });
    expect(render(null).doc).toMatchObject({ type_key: "proposal", type_source: "classifier" });
    await hook.flush();
    expect(calls[0].body).toMatchObject({ type_key: "proposal", type_source: "classifier" });

    // A type picked by hand is the person's, and clearing it clears who set it.
    hook.change({ type_key: "sop" });
    expect(render(null).doc.type_source).toBe("user");
    hook.change({ type_key: null });
    expect(render(null).doc.type_source).toBeNull();
    await hook.flush();
    expect(calls[1].body).toMatchObject({ type_key: null });
  });
});
