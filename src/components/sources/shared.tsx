"use client";

// Pieces the sources panel, the library and the picker share: the source
// types as the API returns them, the status chip, small formatting helpers,
// polling while sources are being read, and the forms for adding a link or a
// note.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, File, Globe, Loader2, NoteIcon } from "@/components/icons";
import type { ExtractionStatus, LinkedSource, SourceDetail, SourceKind, SourceSummary } from "@/lib/sources/store";

export type { ExtractionStatus, LinkedSource, SourceDetail, SourceKind, SourceSummary };

export type FolderItem = { id: string; parent_id: string | null; name: string; document_id: string | null; created_at: string };

/** Statuses after which nothing more happens until someone retries (mirrors the store; that module is server-only). */
const TERMINAL: ExtractionStatus[] = ["ready", "partial", "error"];
export const isBusy = (s: Pick<SourceSummary, "extraction_status">) => !TERMINAL.includes(s.extraction_status);

/** fetch + JSON with the API's `{ error }` message on failure. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "Content-Type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`, res.status, body, res.headers.get("Retry-After"));
  return body as T;
}

/** What api() throws on a non-2xx reply: the server's sentence as the message, plus the status, body and Retry-After for callers that act on them (a background 429 waits quietly). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfter: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function sourceTitle(s: Pick<SourceSummary, "title" | "filename" | "url" | "kind">): string {
  if (s.title) return s.title;
  if (s.filename) return s.filename;
  if (s.url) {
    try {
      const u = new URL(s.url);
      return u.hostname + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      return s.url;
    }
  }
  return s.kind === "note" ? "Untitled note" : "Untitled source";
}

/** Where the source's file or page opens: the team-checked file route, or the link itself. */
export function sourceHref(s: Pick<SourceSummary, "id" | "kind" | "url">): string | null {
  if (s.kind === "file") return `/api/sources/${encodeURIComponent(s.id)}/file`;
  if (s.kind === "url") return s.url;
  return null;
}

export function formatBytes(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function KindIcon({ kind, className = "h-4 w-4" }: { kind: SourceKind; className?: string }) {
  const Icon = kind === "url" ? Globe : kind === "note" ? NoteIcon : File;
  return <Icon className={className} aria-hidden />;
}

const STATUS: Record<ExtractionStatus, { label: string; tone: "busy" | "ok" | "warn" | "bad" }> = {
  uploading: { label: "Uploading", tone: "busy" },
  pending: { label: "Queued", tone: "busy" },
  extracting: { label: "Reading", tone: "busy" },
  summarizing: { label: "Summarizing", tone: "busy" },
  ready: { label: "Ready", tone: "ok" },
  partial: { label: "Partly read", tone: "warn" },
  error: { label: "Couldn't read", tone: "bad" },
};

const TONE = {
  busy: "bg-[var(--doc-accent-soft)] text-[var(--doc-accent)]",
  ok: "bg-green-50 text-green-800 dark:bg-green-950/60 dark:text-green-300",
  warn: "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  bad: "bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300",
};

export function StatusChip({ status, error }: { status: ExtractionStatus; error?: string | null }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <span title={error ?? undefined} className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[s.tone]}`}>
      {s.tone === "busy" ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : s.tone === "ok" ? (
        <CheckCircle2 className="h-3 w-3" aria-hidden />
      ) : (
        <AlertTriangle className="h-3 w-3" aria-hidden />
      )}
      {s.label}
    </span>
  );
}

const POLL_MS = 3000;

/**
 * While any of `sources` is still being read, re-fetch those ones every few
 * seconds and hand the fresh rows to `onUpdate`.
 */
export function usePollSources(sources: Array<Pick<SourceSummary, "id" | "extraction_status">>, onUpdate: (fresh: SourceSummary[]) => void) {
  const busyIds = sources
    .filter(isBusy)
    .map((s) => s.id)
    .sort()
    .join(",");
  const update = useRef(onUpdate);
  update.current = onUpdate;
  useEffect(() => {
    if (!busyIds) return;
    let cancelled = false;
    const t = window.setInterval(async () => {
      try {
        const { sources: fresh } = await api<{ sources: SourceSummary[] }>(`/api/sources?ids=${encodeURIComponent(busyIds)}`);
        if (!cancelled) update.current(fresh);
      } catch {
        /* a blip; try again next tick */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [busyIds]);
}

/** Replace rows in `list` with fresh copies by id (keeping extra fields such as a link's role). */
export function mergeFresh<T extends SourceSummary>(list: T[], fresh: SourceSummary[]): T[] {
  const byId = new Map(fresh.map((s) => [s.id, s]));
  return list.map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id)! } : s));
}

const field = "w-full rounded-md border border-[var(--doc-field-line)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--doc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--doc-accent)]";
const primary = "inline-flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-40";
const quiet = "rounded-md px-2 py-1.5 text-sm text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]";

type Placement = { documentId?: string | null; folderId?: string | null };

function placement(p: Placement) {
  return p.documentId ? { document_id: p.documentId } : p.folderId ? { folder_id: p.folderId } : {};
}

/** Paste a web address; the page is fetched and read in the background. */
export function AddUrlForm({
  idPrefix,
  resolve,
  onAdded,
  onCancel,
  initialUrl = "",
}: {
  idPrefix: string;
  /** Where the source goes; may save the document first. */
  resolve: () => Promise<Placement | null>;
  onAdded: (s: SourceSummary) => void;
  onCancel?: () => void;
  /** Prefills the address (a suggestion's link). */
  initialUrl?: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const where = await resolve();
      if (!where) throw new Error("Save the document first.");
      const { source } = await api<{ source: SourceSummary }>("/api/sources", { method: "POST", json: { kind: "url", url: url.trim(), ...placement(where) } });
      setUrl("");
      onAdded(source);
    } catch (err) {
      setError(errorText(err, "That link couldn't be added."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={`${idPrefix}-url`} className="block text-xs font-medium text-[var(--doc-muted)]">
        Web address
      </label>
      <input id={`${idPrefix}-url`} type="url" inputMode="url" autoFocus required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className={field} />
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !url.trim()} className={primary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Add link
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={quiet}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Write or paste a note to keep as a source. */
export function AddNoteForm({
  idPrefix,
  resolve,
  onAdded,
  onCancel,
}: {
  idPrefix: string;
  resolve: () => Promise<Placement | null>;
  onAdded: (s: SourceSummary) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const where = await resolve();
      if (!where) throw new Error("Save the document first.");
      const { source } = await api<{ source: SourceSummary }>("/api/sources", { method: "POST", json: { kind: "note", title: title.trim(), text, ...placement(where) } });
      setTitle("");
      setText("");
      onAdded(source);
    } catch (err) {
      setError(errorText(err, "The note couldn't be saved."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={`${idPrefix}-note-title`} className="block text-xs font-medium text-[var(--doc-muted)]">
        Title
      </label>
      <input id={`${idPrefix}-note-title`} autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      <label htmlFor={`${idPrefix}-note-text`} className="block text-xs font-medium text-[var(--doc-muted)]">
        Note
      </label>
      <textarea id={`${idPrefix}-note-text`} required rows={5} value={text} onChange={(e) => setText(e.target.value)} className={`${field} resize-y`} />
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !title.trim() || !text.trim()} className={primary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save note
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={quiet}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export const styles = { field, primary, quiet };
