// The team's enabled document types, fetched from GET /api/document-types and
// shared by the type picker, the gallery, the "Start from a type" strip and
// the document switcher. Kept apart from the picker's components so the
// /catalog admin page can invalidate it without loading them.
//
// The list is cached per team (the Clerk organization, or the personal
// workspace) and refetched when it may have changed: after a catalog edit
// (invalidateDocumentTypes, which catalogApi calls after every write), when the
// team changes, when a screen using it mounts again, and when the window
// regains focus (another tab may have edited the catalog).

import type { DocumentTypeSummary } from "@/catalog/schema";
import type { DocumentTypesResponse } from "@/lib/sections/contract";

export type TypesState = { types: DocumentTypeSummary[]; loading: boolean; error: string | null };

/** A mount or a focus refetches at most this often; an invalidation always does. */
export const REVALIDATE_MS = 15_000;

let typesState: TypesState = { types: [], loading: false, error: null };
let request: Promise<void> | null = null;
/** Which team the list (or the request in flight) is for; undefined before the first load. */
let loadedFor: string | undefined;
let fetchedAt = 0;
let stale = false;
/** Bumped by every load, so an older response never overwrites a newer one. */
let generation = 0;
const listeners = new Set<() => void>();

export const SERVER_STATE: TypesState = { types: [], loading: true, error: null };

export function getTypesState(): TypesState {
  return typesState;
}

export function subscribeTypes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setTypesState(next: TypesState) {
  typesState = next;
  listeners.forEach((l) => l());
}

/** Fetch the list for `team` now, replacing any request in flight. */
export function loadTypes(team: string, now: () => number = Date.now): Promise<void> {
  const mine = ++generation;
  // Another team's list must never show, even for a moment.
  const switching = loadedFor !== team;
  loadedFor = team;
  stale = false;
  setTypesState({ types: switching ? [] : typesState.types, loading: true, error: null });
  request = (async () => {
    try {
      const res = await fetch("/api/document-types", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Partial<DocumentTypesResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Couldn't load document types (${res.status}).`);
      if (mine !== generation) return;
      fetchedAt = now();
      setTypesState({ types: Array.isArray(body.types) ? body.types : [], loading: false, error: null });
    } catch (e) {
      if (mine !== generation) return;
      request = null; // let the next caller try again
      setTypesState({ ...typesState, loading: false, error: e instanceof Error ? e.message : "Couldn't load document types." });
    }
  })();
  return request;
}

/**
 * The list for `team`: the cached one while it is fresh, else a new fetch.
 * `maxAgeMs` (a mount, a focus) also refetches a list older than that.
 */
export function ensureTypes(team: string, maxAgeMs = Infinity, now: () => number = Date.now): Promise<void> {
  if (request && !stale && loadedFor === team && (typesState.loading || now() - fetchedAt < maxAgeMs)) return request;
  return loadTypes(team, now);
}

/**
 * The catalog changed (a type was added, edited, enabled, disabled or
 * removed): refetch now if a screen is showing the list, else on next use.
 */
export function invalidateDocumentTypes(): void {
  stale = true;
  if (listeners.size && loadedFor !== undefined) void loadTypes(loadedFor);
}

/** Forget everything (tests). */
export function resetDocumentTypesStore(): void {
  typesState = { types: [], loading: false, error: null };
  request = null;
  loadedFor = undefined;
  fetchedAt = 0;
  stale = false;
  generation++;
  listeners.clear();
}
