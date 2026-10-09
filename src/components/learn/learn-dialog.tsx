"use client";

// "Learn from example" (PLAN §6.11, phase8-spec.md §3.3): pick 1–5 examples
// (the document's linked sources, the current document, sources from the
// library), learn a draft type and workflow from them (one long model call
// with a progress line), then review the draft side by side with the examples
// and save it at the author checkpoint. Opened from the catalog page and from
// the document modal's Sources tab. Errors are shown in place; there are no
// browser alert or confirm prompts.

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Search, Sparkles } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invalidateDocumentTypes } from "@/components/editor/document-types-store";
import { sourceTitle, type SourceSummary } from "@/components/sources/shared";
import {
  LEARN_MAX_EXAMPLES,
  type LearnDraft,
  type LearnErrorResponse,
  type LearnExampleRef,
  type LearnResponse,
  type PersonalDetailFlag,
  type SaveLearnedBlocked,
  type SaveLearnedResponse,
} from "@/lib/learn/contract";
import { canLearn, initialReview, progressLabel, refId, saveRequest, togglePick, withServerValidation, type ReviewState } from "./learn-model";
import { LearnReview } from "./learn-review";

const primary = "inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-40 sm:min-h-9";
const quiet = "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-40 sm:min-h-9";
const field = "w-full rounded-md border border-[var(--doc-line)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--doc-accent)]";
const READY = new Set(["ready", "partial"]);

type Stage = { kind: "pick" } | { kind: "learning"; started: number } | { kind: "review"; draft: LearnDraft } | { kind: "saved"; result: SaveLearnedResponse };

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; status: number; body: LearnErrorResponse & Partial<SaveLearnedBlocked> }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await res.json().catch(() => ({ error: `Request failed (${res.status}).` }));
  return res.ok ? { ok: true, data: data as T } : { ok: false, status: res.status, body: data };
}

export function LearnDialog({
  open,
  onOpenChange,
  linkedSources = [],
  currentDocument = null,
  preselect = [],
  documentId = null,
  onSaved,
  onUseType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The document's linked sources (shown first). */
  linkedSources?: SourceSummary[];
  /** The document the author started from, offered as an example. */
  currentDocument?: { id: string; title: string } | null;
  /** Examples ticked when the dialog opens. */
  preselect?: LearnExampleRef[];
  /** The document the author started from (sent for context and the audit). */
  documentId?: string | null;
  onSaved?: (result: SaveLearnedResponse) => void;
  /** "Use this type for the document": the caller sets the current document's type. */
  onUseType?: (typeKey: string) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [picked, setPicked] = useState<LearnExampleRef[]>(preselect);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [library, setLibrary] = useState<SourceSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverPersonal, setServerPersonal] = useState<PersonalDetailFlag[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const abort = useRef<AbortController | null>(null);

  // A fresh start each time the dialog opens, with the caller's preselection.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setStage({ kind: "pick" });
      setPicked(preselect.slice(0, LEARN_MAX_EXAMPLES));
      setError(null);
      setReview(null);
      setServerPersonal([]);
    }
  }

  useEffect(() => {
    if (!open || library) return;
    let live = true;
    fetch("/api/sources?limit=100", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((b: { sources?: SourceSummary[] }) => live && setLibrary(b.sources ?? []))
      .catch(() => live && setLibrary([]));
    return () => {
      live = false;
    };
  }, [open, library]);

  // The progress line's clock while the model works.
  useEffect(() => {
    if (stage.kind !== "learning") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stage.kind]);

  // Closing stops a running extraction (its result would have nowhere to go).
  useEffect(() => {
    if (!open) abort.current?.abort();
  }, [open]);

  const linkedIds = useMemo(() => new Set(linkedSources.map((s) => s.id)), [linkedSources]);
  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (library ?? []).filter((s) => !linkedIds.has(s.id) && (!q || sourceTitle(s).toLowerCase().includes(q)));
  }, [library, linkedIds, query]);

  const learn = async () => {
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    const started = Date.now();
    setNow(started);
    setStage({ kind: "learning", started });
    try {
      const r = await postJson<LearnResponse>(
        "/api/document-types/learn",
        { examples: picked, ...(documentId ? { documentId } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
        controller.signal,
      );
      if (!r.ok) {
        setError(r.body.error ?? "Learning from the examples failed.");
        setStage({ kind: "pick" });
        return;
      }
      setReview(initialReview(r.data.draft));
      setServerPersonal([]);
      setStage({ kind: "review", draft: r.data.draft });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Learning from the examples failed.");
      setStage({ kind: "pick" });
    }
  };

  const save = async () => {
    if (stage.kind !== "review" || !review) return;
    setSaving(true);
    setError(null);
    try {
      const r = await postJson<SaveLearnedResponse>("/api/document-types/learn/save", saveRequest(review, stage.draft, documentId));
      if (!r.ok) {
        setError(r.body.error ?? "Saving failed.");
        setServerPersonal(r.body.personalDetails ?? []);
        if (r.body.validation) setReview(withServerValidation(review, r.body.validation));
        return;
      }
      invalidateDocumentTypes();
      onSaved?.(r.data);
      setStage({ kind: "saved", result: r.data });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  };

  const row = (ref: LearnExampleRef, label: string, sub: string, disabled = false, why = "") => {
    const id = refId(ref);
    const checked = picked.some((p) => refId(p) === id);
    const full = !checked && picked.length >= LEARN_MAX_EXAMPLES;
    return (
      <li key={id}>
        <label className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm sm:min-h-9 ${disabled || full ? "opacity-50" : "hover:bg-[var(--doc-accent-soft)]"}`}>
          <Checkbox className="mt-0.5" checked={checked} disabled={disabled || full} onCheckedChange={() => setPicked((p) => togglePick(p, ref))} />
          <span className="min-w-0">
            <span className="block truncate">{label}</span>
            <span className="block text-xs text-[var(--doc-muted)]">{disabled ? why : sub}</span>
          </span>
        </label>
      </li>
    );
  };
  const sourceRow = (s: SourceSummary) => row({ kind: "source", sourceId: s.id }, sourceTitle(s), s.kind === "file" ? (s.filename ?? "File") : s.kind === "url" ? "Web page" : "Note", !READY.has(s.extraction_status), "Still reading; ready soon.");

  const wide = stage.kind === "review";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-2xl border-[var(--doc-line)] bg-[var(--doc-surface)] font-sans text-[var(--doc-ink)] ${wide ? "h-[90dvh] sm:max-w-6xl" : "sm:max-w-xl"}`}
      >
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-4 w-4" /> Learn a type from examples
          </DialogTitle>
          <DialogDescription>
            {stage.kind === "review"
              ? "Check the draft against the examples. Nothing is saved until you confirm."
              : "Sasha drafts a document type and a review workflow from 1 to 5 examples of the same kind of document. More examples give a better result."}
          </DialogDescription>
        </DialogHeader>

        {stage.kind === "pick" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {(currentDocument || linkedSources.length > 0) && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">This document</h3>
                <ul>
                  {currentDocument && row({ kind: "document", documentId: currentDocument.id }, currentDocument.title.trim() || "Untitled document", "The document itself")}
                  {linkedSources.map(sourceRow)}
                </ul>
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">Your library</h3>
              <label className="relative mb-1 block">
                <span className="sr-only">Search sources</span>
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--doc-muted)]" />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sources" className={`${field} pl-8`} />
              </label>
              {!library ? (
                <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading sources…
                </p>
              ) : others.length ? (
                <ul className="max-h-60 overflow-y-auto">{others.map(sourceRow)}</ul>
              ) : (
                <p className="text-sm text-[var(--doc-muted)]">{query ? "No sources match." : "Upload examples as sources first (Sources in the menu)."}</p>
              )}
            </section>
            <section className="grid gap-2">
              <label className="space-y-1 text-xs font-medium text-[var(--doc-muted)]">
                Name for the type (optional)
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Equipment request" className={field} />
              </label>
              <label className="space-y-1 text-xs font-medium text-[var(--doc-muted)]">
                What you want it for (optional)
                <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} className={`${field} resize-y`} />
              </label>
            </section>
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={primary} disabled={!canLearn(picked)} onClick={() => void learn()}>
                <Sparkles className="h-4 w-4" /> Learn from {picked.length || "the"} example{picked.length === 1 ? "" : "s"}
              </button>
              <span className="text-xs text-[var(--doc-muted)]">
                {picked.length}/{LEARN_MAX_EXAMPLES} picked{picked.length === 1 ? " · one example gives a low-confidence draft" : ""}
              </span>
            </div>
          </div>
        )}

        {stage.kind === "learning" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-sm" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--doc-accent)]" />
            <p>{progressLabel(now - stage.started, picked.length)}</p>
            <p className="text-xs text-[var(--doc-muted)]">This usually takes one to four minutes. {Math.round((now - stage.started) / 1000)} s</p>
            <button
              type="button"
              className={quiet}
              onClick={() => {
                abort.current?.abort();
                setStage({ kind: "pick" });
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {stage.kind === "review" && review && <LearnReview draft={stage.draft} state={review} onChange={setReview} onSave={() => void save()} saving={saving} error={error} serverPersonal={serverPersonal} />}

        {stage.kind === "saved" && (
          <div className="flex flex-col gap-3 py-6 text-sm" role="status">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-5 w-5 text-[var(--go)]" /> Saved “{stage.result.type.title}” as a team type.
            </p>
            <ul className="ml-6 list-disc text-[var(--doc-muted)]">
              <li>
                <FileText className="mr-1 inline h-3.5 w-3.5" />
                {stage.result.type.sections.length} sections; your team can pick it like any other type.
              </li>
              {stage.result.workflow && <li>Workflow “{stage.result.workflow.name}”: offered on documents of this type.</li>}
              {stage.result.requirementSets.length > 0 && <li>{stage.result.requirementSets.length} inferred requirement set(s), shown as “inferred from examples”.</li>}
            </ul>
            <div className="flex flex-wrap gap-2">
              {onUseType && documentId && (
                <button
                  type="button"
                  className={primary}
                  onClick={() => {
                    onUseType(stage.result.type.key);
                    onOpenChange(false);
                  }}
                >
                  Use it for this document
                </button>
              )}
              <button type="button" className={quiet} onClick={() => onOpenChange(false)}>
                Close
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
