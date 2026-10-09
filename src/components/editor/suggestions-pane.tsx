"use client";

// The Suggestions tab (PLAN §6.4, phase4-spec.md §4.6): suggested sources,
// data and web resources for the document, grouped by kind and by the type
// section they serve, with Add / Dismiss, a collapsed Done group, a collapsed
// Dismissed group with Restore, and "Add your own".
//
// Opening the tab saves any queued notes or type change, then loads the list
// and regenerates it when the inputs changed since the last generation (the
// server rate-gates and short-circuits).
// Actions update the list at once and roll back with an inline error if the
// save fails. "Add" on a source or web item hands over to the Sources tab
// (onAddSource), and on a data item to the Data tab (onAddData); each marks
// the suggestion added once a source or table is linked for it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, X } from "@/components/icons";
import { api, ApiError, errorText, sourceTitle, styles, type LinkedSource } from "@/components/sources/shared";
import type { DocumentDataResponse } from "@/lib/data/contract";
import type {
  DataPrefill,
  SourcePrefill,
  SuggestionActionRequest,
  SuggestionGenerateResponse,
  SuggestionListResponse,
  SuggestionRecord,
  SuggestionResponse,
} from "@/lib/suggestions/contract";
import { MAX_SUGGESTION_LABEL } from "@/lib/suggestions/contract";
import { retryAfterMs } from "@/lib/limits/client";
import { applyAction, dismissedItems, doneItems, doneText, groupOpen, loadAfterSave, reasonView, showEmptyHint, upsertRow } from "./suggestions-model";
import { findType, useDocumentTypes } from "./type-picker";

type GenerateReply = SuggestionGenerateResponse & { retry_after_ms?: number };

const base = (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}/suggestions`;

export function SuggestionsPane({
  documentId,
  typeKey,
  ensureSaved,
  onAddSource,
  onAddData,
}: {
  documentId: string | null;
  typeKey: string | null;
  /** Sends the document's queued changes (use-document flush) before the list loads, so staleness is judged on the current notes and type. */
  ensureSaved?: () => Promise<string | null>;
  /** "Add" on a source or web suggestion: switch to the Sources tab with this prefill. */
  onAddSource: (prefill: SourcePrefill) => void;
  /** "Add" on a data suggestion: switch to the Data tab with this prefill (without it, the item is just marked added). */
  onAddData?: (prefill: DataPrefill) => void;
}) {
  const { types } = useDocumentTypes();
  const type = findType(types, typeKey);
  const sections = useMemo(() => (type?.sections ?? []).map((s) => ({ key: s.key, heading: s.heading })), [type]);

  const [rows, setRows] = useState<SuggestionRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [sourceTitles, setSourceTitles] = useState<Map<string, string>>(new Map());
  const [tableNames, setTableNames] = useState<Map<string, string>>(new Map());
  const retry = useRef<number | null>(null);
  const alive = useRef(true);
  // Read through a ref so a new callback identity doesn't reload the list.
  const ensureSavedRef = useRef(ensureSaved);
  ensureSavedRef.current = ensureSaved;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (retry.current) window.clearTimeout(retry.current);
    };
  }, []);

  const adopt = useCallback((list: SuggestionListResponse) => {
    setRows(list.suggestions);
    setLastError(list.error);
  }, []);

  const generate = useCallback(
    async (id: string, force: boolean) => {
      if (retry.current) window.clearTimeout(retry.current);
      retry.current = null;
      setGenerating(true);
      setNote(null);
      try {
        const reply = await api<GenerateReply>(`${base(id)}/generate`, { method: "POST", json: force ? { force: true } : {} });
        if (!alive.current) return;
        adopt(reply);
        if (!reply.ran && reply.stale && reply.retry_after_ms) {
          // The per-minute gate held this run back: try once more when it opens.
          if (force) setNote("Suggestions were updated less than a minute ago. They'll refresh again shortly.");
          retry.current = window.setTimeout(() => void generate(id, false), reply.retry_after_ms + 500);
        }
      } catch (e) {
        if (!alive.current) return;
        // An automatic refresh over the rate limit waits quietly and tries
        // again when the window opens; a click on Refresh shows the sentence.
        const wait = !force && e instanceof ApiError ? retryAfterMs(e.status, e.body, e.retryAfter) : null;
        if (wait !== null) retry.current = window.setTimeout(() => void generate(id, false), wait + 500);
        else setLastError(errorText(e, "Couldn't update the suggestions."));
      } finally {
        if (alive.current) setGenerating(false);
      }
    },
    [adopt],
  );

  // Load on open and when the type changes; regenerate when the inputs moved on.
  useEffect(() => {
    if (!documentId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const [list, linked, data] = await loadAfterSave(ensureSavedRef.current, () =>
          Promise.all([
            api<SuggestionListResponse>(base(documentId)),
            api<{ sources: LinkedSource[] }>(`/api/documents/${encodeURIComponent(documentId)}/sources`).catch(() => ({ sources: [] as LinkedSource[] })),
            api<DocumentDataResponse>(`/api/documents/${encodeURIComponent(documentId)}/data`).catch((): DocumentDataResponse => ({ tables: [] })),
          ]),
        );
        if (cancelled) return;
        adopt(list);
        setSourceTitles(new Map(linked.sources.map((s) => [s.id, sourceTitle(s)])));
        setTableNames(new Map(data.tables.map((t) => [t.id, t.name])));
        if (list.stale) void generate(documentId, false);
      } catch (e) {
        if (!cancelled) {
          setLoadError(errorText(e, "Couldn't load the suggestions."));
          setRows((r) => r ?? []);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, typeKey, adopt, generate]);

  const act = async (row: SuggestionRecord, action: SuggestionActionRequest["action"]) => {
    if (!documentId) return;
    setPending(row.id);
    setRowErrors(({ [row.id]: _gone, ...rest }) => (void _gone, rest));
    setRows((list) => list && upsertRow(list, applyAction(row, action)));
    try {
      const { suggestion } = await api<SuggestionResponse>(`${base(documentId)}/${encodeURIComponent(row.id)}`, { method: "PATCH", json: { action } });
      if (alive.current) setRows((list) => list && upsertRow(list, suggestion));
    } catch (e) {
      if (!alive.current) return;
      setRows((list) => list && upsertRow(list, row));
      setRowErrors((errs) => ({ ...errs, [row.id]: errorText(e, "That didn't save. Try again.") }));
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const add = (row: SuggestionRecord) => {
    if (row.kind === "data") {
      if (onAddData) onAddData({ suggestionId: row.id, label: row.label });
      else void act(row, "add");
    } else onAddSource({ suggestionId: row.id, label: row.label, url: row.url });
  };

  if (!documentId) return <p className="px-6 pb-6 text-sm text-[var(--doc-muted)]">Suggestions appear once the document is saved.</p>;

  const all = rows ?? [];
  const groups = groupOpen(all, sections);
  const done = doneItems(all);
  const dismissed = dismissedItems(all);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-6 pb-3">
        <p aria-live="polite" className="flex min-h-5 items-center gap-1.5 text-xs text-[var(--doc-muted)]">
          {generating && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Updating suggestions…
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => void generate(documentId, true)}
          disabled={generating}
          className="flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[var(--go)] hover:bg-[var(--go-soft)] disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
        {loadError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        )}
        {lastError && <p className="text-xs text-amber-800 dark:text-amber-200">The last update didn&apos;t finish ({lastError}). The list below is from before.</p>}
        {note && <p className="text-xs text-[var(--doc-muted)]">{note}</p>}

        {rows === null ? (
          <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading suggestions…
          </p>
        ) : showEmptyHint(all, typeKey) && !generating ? (
          <p className="text-sm text-[var(--doc-muted)]">Choose a document type or write some notes and suggestions will appear here.</p>
        ) : groups.length === 0 && !generating ? (
          <p className="text-sm text-[var(--doc-muted)]">{done.length ? "Everything suggested is covered." : "No suggestions right now."}</p>
        ) : null}

        {groups.map((g) => (
          <section key={g.kind} aria-label={g.title} className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">
              {g.title} <span className="font-normal">({g.count})</span>
            </h3>
            {g.sections.map((s) => (
              <div key={s.key} className="space-y-1.5">
                <p className="text-xs font-medium text-[var(--doc-ink)]">{s.heading}</p>
                <ul className="space-y-1.5">
                  {s.items.map((row) => (
                    <li key={row.id} className="rounded-xl border border-[var(--doc-line)] px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium leading-snug">
                            {row.label}
                            {reasonView(row).unverified && (
                              <span
                                title="Found on the web by a workflow; nobody has checked it yet"
                                className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-px align-middle text-[11px] font-semibold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
                              >
                                Unverified
                              </span>
                            )}
                          </p>
                          {reasonView(row).reason && <p className="mt-0.5 text-xs leading-relaxed text-[var(--doc-muted)]">{reasonView(row).reason}</p>}
                        </div>
                        <button
                          type="button"
                          onClick={() => add(row)}
                          disabled={pending === row.id}
                          className="flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-[var(--go-soft)] px-3 text-xs font-semibold text-[var(--go)] hover:bg-[var(--go-soft-strong)] disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden /> Add
                        </button>
                        <button
                          type="button"
                          onClick={() => void act(row, "dismiss")}
                          disabled={pending === row.id}
                          aria-label={`Dismiss: ${row.label}`}
                          title="Dismiss"
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)] disabled:opacity-50"
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                      {rowErrors[row.id] && (
                        <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                          {rowErrors[row.id]}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}

        <AddOwnForm documentId={documentId} onAdded={(row) => setRows((list) => upsertRow(list ?? [], row))} />

        {done.length > 0 && (
          <Collapsible title={`Done (${done.length})`}>
            <ul className="space-y-1">
              {done.map((row) => (
                <li key={row.id} className="flex items-start gap-2 py-1 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--go)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words">{row.label}</span>
                    <span className="block text-xs text-[var(--doc-muted)]">{doneText(row, sourceTitles, tableNames)}</span>
                    {rowErrors[row.id] && <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{rowErrors[row.id]}</span>}
                  </span>
                  <button type="button" onClick={() => void act(row, "restore")} disabled={pending === row.id} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--action)] hover:bg-[var(--action-soft)] disabled:opacity-50">
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}

        {dismissed.length > 0 && (
          <Collapsible title={`Dismissed (${dismissed.length})`}>
            <ul className="space-y-1">
              {dismissed.map((row) => (
                <li key={row.id} className="flex items-start gap-2 py-1 text-sm text-[var(--doc-muted)]">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words line-through">{row.label}</span>
                    {rowErrors[row.id] && <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{rowErrors[row.id]}</span>}
                  </span>
                  <button type="button" onClick={() => void act(row, "restore")} disabled={pending === row.id} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--action)] hover:bg-[var(--action-soft)] disabled:opacity-50">
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}
      </div>
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-[var(--doc-line)] pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-9 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)] hover:text-[var(--doc-ink)]"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />} {title}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </section>
  );
}

/** "Add your own": a kind and a label, saved as the person's own suggestion. */
function AddOwnForm({ documentId, onAdded }: { documentId: string; onAdded: (row: SuggestionRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"source" | "data">("source");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[var(--go)] hover:bg-[var(--go-soft)]">
        <Plus className="h-4 w-4" aria-hidden /> Add your own
      </button>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { suggestion } = await api<SuggestionResponse>(base(documentId), { method: "POST", json: { kind, label: label.trim() } });
      onAdded(suggestion);
      setLabel("");
      setOpen(false);
    } catch (err) {
      setError(errorText(err, "That couldn't be added."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Add your own suggestion" className="space-y-2 rounded-xl border border-[var(--doc-line)] p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="suggestion-own-kind" className="block text-xs font-medium text-[var(--doc-muted)]">
            Kind
          </label>
          <select id="suggestion-own-kind" value={kind} onChange={(e) => setKind(e.target.value as "source" | "data")} className={`${styles.field} w-auto`}>
            <option value="source">Source</option>
            <option value="data">Data</option>
          </select>
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <label htmlFor="suggestion-own-label" className="block text-xs font-medium text-[var(--doc-muted)]">
            What to gather
          </label>
          <input
            id="suggestion-own-label"
            autoFocus
            value={label}
            maxLength={MAX_SUGGESTION_LABEL}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={kind === "source" ? "e.g. Last year's annual report" : "e.g. Monthly sales figures"}
            className={styles.field}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !label.trim()} className={styles.primary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Add
        </button>
        <button type="button" onClick={() => setOpen(false)} className={styles.quiet}>
          Cancel
        </button>
      </div>
    </form>
  );
}
