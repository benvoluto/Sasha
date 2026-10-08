"use client";

// Loads a document and saves changes as the person types. A new document (no
// id yet) is created on its first change; the URL then moves to /d/<id>
// without remounting the editor. Saves are debounced and carry the version
// they were based on, so a save over a teammate's newer edit surfaces as a
// conflict instead of overwriting it. A failed save is retried with backoff
// only when retrying can help (offline, server error); otherwise the changes
// stay pending until the person edits again or resolves the problem.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PMNode } from "@/lib/documents/sections";

export type DocState = {
  id: string | null;
  title: string;
  type_key: string | null;
  content_json: PMNode | null;
  updated_at: string | null;
};

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

type Patch = Partial<Pick<DocState, "title" | "type_key" | "content_json">>;

const SAVE_DELAY_MS = 1200;
const MAX_RETRY_DELAY_MS = 30_000;
/** Browsers refuse keepalive requests whose bodies add up to more than 64KB. */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * How long to wait before retrying a failed save, or null to wait for the
 * person instead. Only a network failure (no status) or a server error is worth
 * retrying; a 4xx (conflict, deleted, forbidden, invalid, too large) would fail
 * the same way again.
 */
export function saveRetryDelay(status: number | null, attempt: number): number | null {
  if (status !== null && status < 500) return null;
  return Math.min(SAVE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/** Whether a request body is small enough to send with `keepalive`. */
export function fitsKeepalive(body: string): boolean {
  return new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
}

function saveErrorMessage(status: number): string {
  if (status === 413) return "This document is too large to save.";
  if (status === 404) return "This document no longer exists, so changes can't be saved.";
  if (status === 403) return "You don't have permission to save this document.";
  return `Save failed (${status}).`;
}

type FlushOptions = {
  /** Overwrite a teammate's newer version (the person chose "Keep mine"). */
  force?: boolean;
  /** The tab is being hidden or closed: send with keepalive when the body allows it. */
  keepalive?: boolean;
  /** The page is unloading: don't wait for a save already in flight. */
  unloading?: boolean;
};

export function useDocument(initialId: string | null) {
  const [doc, setDoc] = useState<DocState>({ id: initialId, title: "", type_key: null, content_json: null, updated_at: null });
  const [loading, setLoading] = useState(!!initialId);
  const [notFound, setNotFound] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  /** The newer version someone else saved, when a save conflicted. */
  const [conflict, setConflict] = useState<DocState | null>(null);

  const pending = useRef<Patch>({});
  const timer = useRef<number | null>(null);
  /** A retry after a failed save is scheduled; typing doesn't bring it forward. */
  const retrying = useRef(false);
  /** Failed saves in a row, for the retry backoff. */
  const failures = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;

  // Load an existing document.
  useEffect(() => {
    if (!initialId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(initialId)}`, { cache: "no-store" });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Couldn't open this document (${res.status}).`);
        const { document: d } = await res.json();
        if (!cancelled) setDoc({ id: d.id, title: d.title, type_key: d.type_key, content_json: d.content_json, updated_at: d.updated_at });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open this document.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialId]);

  const clearTimer = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    retrying.current = false;
  }, []);

  /**
   * Send pending changes now. Resolves to the document's id afterwards (null if
   * it still doesn't exist), read from the hook's own ref: the `doc` state a
   * caller holds only catches up on its next render, after this resolves.
   */
  const flush = useCallback(async (opts: FlushOptions = {}): Promise<string | null> => {
    clearTimer();
    if (inFlight.current) {
      // Leaving the page: a second save now would race the first (and conflict
      // with it); the beforeunload prompt covers what is still unsaved.
      if (opts.unloading) return docRef.current.id;
      await inFlight.current;
    }
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return docRef.current.id;
    pending.current = {};
    const current = docRef.current;
    // Where the person is now, so a new document's URL is only set if they are still here.
    const here = window.location.pathname + window.location.search;
    let saved = false;
    let retryIn: number | null = null;

    const run = (async () => {
      setStatus("saving");
      let httpStatus: number | null = null;
      try {
        const body = current.id
          ? JSON.stringify({ ...patch, base_updated_at: current.updated_at, force: !!opts.force })
          : JSON.stringify({ title: current.title, type_key: current.type_key, content_json: current.content_json ?? undefined });
        const res = await fetch(current.id ? `/api/documents/${encodeURIComponent(current.id)}` : "/api/documents", {
          method: current.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // A larger body goes as a normal request: it still completes when the
          // tab is only hidden, and beforeunload prompts if the tab is closing.
          keepalive: !!opts.keepalive && fitsKeepalive(body),
        });
        httpStatus = res.status;
        const out = await res.json().catch(() => ({}));
        if (res.status === 409 && out.document) {
          // Keep the unsaved changes so "Keep mine" can resend them.
          pending.current = { ...patch, ...pending.current };
          const d = out.document;
          setConflict({ id: d.id, title: d.title, type_key: d.type_key, content_json: d.content_json, updated_at: d.updated_at });
          setStatus("conflict");
          return;
        }
        if (!res.ok) throw new Error(out.error ?? saveErrorMessage(res.status));
        const d = out.document;
        const created = !current.id;
        setDoc((prev) => ({ ...prev, id: d.id, updated_at: d.updated_at }));
        docRef.current = { ...docRef.current, id: d.id, updated_at: d.updated_at };
        if (created && mounted.current && window.location.pathname + window.location.search === here) {
          window.history.replaceState(null, "", `/d/${d.id}`);
        }
        failures.current = 0;
        saved = true;
        setError(null);
        setStatus(Object.keys(pending.current).length ? "saving" : "saved");
      } catch (e) {
        // Keep the changes pending: a retry, the next edit or "Keep mine" sends them.
        pending.current = { ...patch, ...pending.current };
        retryIn = saveRetryDelay(httpStatus, failures.current++);
        setError(e instanceof Error ? e.message : "Save failed.");
        setStatus("error");
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
    if (!mounted.current || opts.unloading) return docRef.current.id;
    if (retryIn !== null) {
      schedule(retryIn);
      retrying.current = true;
    } else if (saved && Object.keys(pending.current).length && docRef.current.id) {
      // Changes made while this save was in flight.
      schedule();
    }
    return docRef.current.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = useCallback(
    (delay = SAVE_DELAY_MS) => {
      clearTimer();
      timer.current = window.setTimeout(() => void flush(), delay);
    },
    [clearTimer, flush],
  );

  /** Record a change and save it shortly. */
  const change = useCallback(
    (patch: Patch) => {
      setDoc((prev) => ({ ...prev, ...patch }));
      docRef.current = { ...docRef.current, ...patch };
      pending.current = { ...pending.current, ...patch };
      if (retrying.current) return; // the scheduled retry sends this too
      if (docRef.current.id || hasContent(docRef.current)) schedule();
    },
    [schedule],
  );

  /** After a conflict: take the other version (losing unsaved changes) or overwrite it with ours. */
  const resolveConflict = useCallback(
    async (choice: "theirs" | "mine") => {
      const other = conflict;
      setConflict(null);
      if (!other) return;
      if (choice === "theirs") {
        pending.current = {};
        setDoc(other);
        docRef.current = other;
        setStatus("saved");
        return;
      }
      docRef.current = { ...docRef.current, updated_at: other.updated_at };
      pending.current = { title: docRef.current.title, type_key: docRef.current.type_key, content_json: docRef.current.content_json ?? undefined, ...pending.current };
      await flush({ force: true });
    },
    [conflict, flush],
  );

  // Save what's left when the tab is hidden or closed.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && Object.keys(pending.current).length) void flush({ keepalive: true });
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) {
        void flush({ keepalive: true, unloading: true });
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [flush]);

  // Leaving the editor inside the app: stop the timers and send what's unsaved.
  // That save finishes in the background and, with the hook unmounted, neither
  // moves the URL nor schedules anything further.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      if (Object.keys(pending.current).length && (docRef.current.id || hasContent(docRef.current))) void flush();
    };
  }, [clearTimer, flush]);

  return { doc, loading, notFound, status, error, conflict, change, flush, resolveConflict };
}

function hasContent(d: DocState): boolean {
  if (d.title.trim()) return true;
  if (d.type_key) return true;
  const text = JSON.stringify(d.content_json?.content ?? []);
  return /"text":"[^"]*\S/.test(text) || /"type":"(table|image|horizontalRule)"/.test(text);
}
