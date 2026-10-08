"use client";

// Element statuses for the living outline, from POST /api/documents/[id]/outline-status
// (Haiku reads the saved document). Asked for when the document opens with a
// type, right after the save that records a new type, and otherwise 4 s after a
// successful save, at most once every 30 s. A result for a type the document no
// longer has is dropped.

import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineStatusResponse } from "@/lib/sections/contract";
import type { SaveStatus } from "./use-document";

const AFTER_SAVE_MS = 4000;
const MIN_INTERVAL_MS = 30_000;

/** How long to wait before the next refresh after a save, given when the last one ran. */
export function nextRefreshDelay(now: number, lastRunAt: number | null): number {
  if (lastRunAt === null) return AFTER_SAVE_MS;
  return Math.max(AFTER_SAVE_MS, lastRunAt + MIN_INTERVAL_MS - now);
}

export function useOutlineStatus({ documentId, typeKey, saveStatus }: { documentId: string | null; typeKey: string | null; saveStatus: SaveStatus }) {
  const [status, setStatus] = useState<OutlineStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const typeRef = useRef(typeKey);
  typeRef.current = typeKey;
  const docRef = useRef(documentId);
  docRef.current = documentId;
  const lastRunAt = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  /** The type changed and the save carrying it hasn't completed yet. */
  const typeChanged = useRef(false);
  const prevSave = useRef(saveStatus);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const refresh = useCallback(async (force = false) => {
    clear();
    const id = docRef.current;
    const key = typeRef.current;
    if (!id || !key) return;
    lastRunAt.current = Date.now();
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(id)}/outline-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof out.error === "string" ? out.error : `Couldn't check the outline (${res.status}).`);
      const result = out as OutlineStatusResponse;
      // The type may have changed while this ran; keep only a result for the current one.
      if (typeRef.current !== key || docRef.current !== id || result.typeKey !== key) return;
      setStatus(result);
      setError(null);
    } catch (e) {
      if (typeRef.current === key) setError(e instanceof Error ? e.message : "Couldn't check the outline.");
    }
  }, []);

  // Opening a document that has a type: ask once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !documentId) return;
    opened.current = true;
    if (typeKey) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  // A new type: drop the old statuses and ask after the save that records it.
  const firstType = useRef(true);
  useEffect(() => {
    if (firstType.current) {
      firstType.current = false;
      return;
    }
    setStatus((s) => (s && s.typeKey === typeKey ? s : null));
    setError(null);
    typeChanged.current = !!typeKey;
    clear();
  }, [typeKey]);

  useEffect(() => {
    const was = prevSave.current;
    prevSave.current = saveStatus;
    if (saveStatus !== "saved" || was === "saved" || !docRef.current || !typeRef.current) return;
    if (typeChanged.current) {
      typeChanged.current = false;
      void refresh();
      return;
    }
    clear();
    timer.current = window.setTimeout(() => void refresh(), nextRefreshDelay(Date.now(), lastRunAt.current));
  }, [saveStatus, refresh]);

  useEffect(() => clear, []);

  return { status, error, refresh };
}
