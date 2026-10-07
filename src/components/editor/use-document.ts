"use client";

// Loads a document and saves changes as the person types. A new document (no
// id yet) is created on its first change; the URL then moves to /d/<id>
// without remounting the editor. Saves are debounced and carry the version
// they were based on, so a save over a teammate's newer edit surfaces as a
// conflict instead of overwriting it.

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
  const inFlight = useRef<Promise<void> | null>(null);
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

  const flush = useCallback(async (opts: { force?: boolean; keepalive?: boolean } = {}): Promise<void> => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;
    pending.current = {};
    const current = docRef.current;

    const run = (async () => {
      setStatus("saving");
      try {
        let res: Response;
        if (!current.id) {
          res = await fetch("/api/documents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: current.title, type_key: current.type_key, content_json: current.content_json ?? undefined }),
            keepalive: opts.keepalive,
          });
        } else {
          res = await fetch(`/api/documents/${encodeURIComponent(current.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...patch, base_updated_at: current.updated_at, force: !!opts.force }),
            keepalive: opts.keepalive,
          });
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.document) {
          // Keep the unsaved changes so "Keep mine" can resend them.
          pending.current = { ...patch, ...pending.current };
          const d = body.document;
          setConflict({ id: d.id, title: d.title, type_key: d.type_key, content_json: d.content_json, updated_at: d.updated_at });
          setStatus("conflict");
          return;
        }
        if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status}).`);
        const d = body.document;
        const created = !current.id;
        setDoc((prev) => ({ ...prev, id: d.id, updated_at: d.updated_at }));
        docRef.current = { ...docRef.current, id: d.id, updated_at: d.updated_at };
        if (created) window.history.replaceState(null, "", `/d/${d.id}`);
        setError(null);
        setStatus(Object.keys(pending.current).length ? "saving" : "saved");
      } catch (e) {
        pending.current = { ...patch, ...pending.current };
        setError(e instanceof Error ? e.message : "Save failed.");
        setStatus("error");
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
    // Changes made while this save was in flight.
    if (Object.keys(pending.current).length && docRef.current.id && !opts.keepalive) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  /** Record a change and save it shortly. */
  const change = useCallback(
    (patch: Patch) => {
      setDoc((prev) => ({ ...prev, ...patch }));
      docRef.current = { ...docRef.current, ...patch };
      pending.current = { ...pending.current, ...patch };
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
        void flush({ keepalive: true });
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

  return { doc, loading, notFound, status, error, conflict, change, flush, resolveConflict };
}

function hasContent(d: DocState): boolean {
  if (d.title.trim()) return true;
  if (d.type_key) return true;
  const text = JSON.stringify(d.content_json?.content ?? []);
  return /"text":"[^"]*\S/.test(text) || /"type":"(table|image|horizontalRule)"/.test(text);
}
