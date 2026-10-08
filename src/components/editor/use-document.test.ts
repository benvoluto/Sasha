import { afterEach, describe, expect, it, vi } from "vitest";

// A stand-in for React's hooks, so useDocument can run as a plain function:
// state setters are recorded but never applied, like a render that hasn't
// happened yet (React runs a fetch-triggered render in a later task).
vi.mock("react", () => ({
  useState: <T>(initial: T | (() => T)) => [typeof initial === "function" ? (initial as () => T)() : initial, () => {}],
  useRef: <T>(current: T) => ({ current }),
  useCallback: <T>(fn: T) => fn,
  useEffect: () => {},
}));

import { fitsKeepalive, saveRetryDelay, useDocument } from "./use-document";

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

    const hook = useDocument(null);
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
    const hook = useDocument(null);
    hook.change({ title: "Plan" });
    expect(await hook.flush()).toBeNull();
  });
});
