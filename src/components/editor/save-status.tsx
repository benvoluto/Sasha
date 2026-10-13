"use client";

// The save status at the end of the toolbar row (redesign3-spec.md §11):
// "Saving…", "Saved N min ago" (a relative time that keeps itself current),
// "Not saved" / the error, or "Not saved yet" for a new document. A polite
// live region announces only state changes, never the ticking minutes: the
// visible text is aria-hidden and an sr-only copy says just "Saved",
// "Saving…" and so on. Both copies contain those words, so the e2e checks can
// use toContainText on the root.
//
// The root carries `data-save-status` (the e2e saveStatus helper finds it by
// that). CONTRACT (redesign 3 foundation): props fixed; the editor-chrome track owns
// the implementation, the editor-panels track renders it in document-screen.

import { useEffect, useState } from "react";
import { Loader2 } from "@/components/icons";
import { savedAgo } from "./save-status-model";
import type { SaveStatus as SaveStatusValue } from "./use-document";

export type SaveStatusProps = {
  status: SaveStatusValue;
  error: string | null;
  /** The document has never been saved (no id yet). */
  isNew: boolean;
  /** The document's updated_at (ISO), or null before the first save. */
  savedAt: string | null;
};

/** How often the relative time is redrawn. */
const TICK_MS = 30_000;

export function SaveStatus({ status, error, isNew, savedAt }: SaveStatusProps) {
  const failed = status === "error" || status === "conflict";
  const showsTime = !failed && status !== "saving" && !isNew && savedAt !== null;
  const now = useNow(showsTime);

  let announced: string;
  let shown: string;
  if (status === "saving") announced = shown = "Saving…";
  else if (failed) announced = shown = (status === "error" && error) || "Not saved";
  else if (isNew) announced = shown = "Not saved yet";
  else if (savedAt !== null) [announced, shown] = ["Saved", savedAgo(savedAt, now)];
  else announced = shown = status === "saved" ? "Saved" : "";

  return (
    <span
      data-save-status
      role="status"
      aria-live="polite"
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[15px] ${failed ? "text-[var(--alert-danger-ink)]" : "text-[var(--doc-muted)]"}`}
    >
      <span className="sr-only">{announced}</span>
      <span aria-hidden className="inline-flex items-center gap-1.5">
        {status === "saving" && <Loader2 className="h-4 w-4 animate-spin" />}
        {shown}
      </span>
    </span>
  );
}

/** The current time, refreshed every TICK_MS while `ticking`; the interval is cleared on unmount. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}
