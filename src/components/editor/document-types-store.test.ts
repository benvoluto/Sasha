import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTypes, getTypesState, invalidateDocumentTypes, loadTypes, resetDocumentTypesStore, subscribeTypes } from "./document-types-store";

const type = (key: string) => ({ key, title: key });

describe("document types store", () => {
  let lists: Record<string, string[]>;
  let team: string;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ types: (lists[team] ?? []).map(type) }), { status: 200 }));
  let clock = 1_000_000;
  const now = () => clock;
  const keys = () => getTypesState().types.map((t) => t.key);

  beforeEach(() => {
    resetDocumentTypesStore();
    lists = { a: ["memo", "business-plan"], b: ["sop"] };
    team = "a";
    clock = 1_000_000;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shares one fetch while the list is fresh", async () => {
    await ensureTypes("a", 15_000, now);
    await ensureTypes("a", 15_000, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keys()).toEqual(["memo", "business-plan"]);
    // A mount or focus later than the window refetches.
    clock += 20_000;
    await ensureTypes("a", 15_000, now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches after a catalog edit, at once when a screen shows the list, else on next use", async () => {
    await ensureTypes("a", Infinity, now);
    // An admin disables a type and adds one on /catalog (nothing subscribed).
    lists.a = ["memo", "team-brief"];
    invalidateDocumentTypes();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ensureTypes("a", Infinity, now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keys()).toEqual(["memo", "team-brief"]);

    const off = subscribeTypes(() => {});
    lists.a = ["memo"];
    invalidateDocumentTypes();
    await vi.waitFor(() => expect(keys()).toEqual(["memo"]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    off();
  });

  it("drops the previous team's list when the team changes", async () => {
    await ensureTypes("a", Infinity, now);
    team = "b";
    const switching = ensureTypes("b", Infinity, now);
    expect(keys()).toEqual([]);
    await switching;
    expect(keys()).toEqual(["sop"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a slower, older response", async () => {
    let releaseOld!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseOld = () => resolve(new Response(JSON.stringify({ types: [type("old")] }), { status: 200 })))),
    );
    const first = loadTypes("a", now);
    await loadTypes("a", now);
    releaseOld();
    await first;
    expect(keys()).toEqual(["memo", "business-plan"]);
  });
});
