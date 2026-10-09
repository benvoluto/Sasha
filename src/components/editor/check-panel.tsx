"use client";

// The rubric Check results (PLAN §6.9) in the lower slot of the right column:
// criteria grouped by how much work they need, each a disclosure with its
// level scale, rationale, quoted evidence (a button that selects the quote in
// the editor) and a fix. Apply runs the fix as a section rewrite through the
// generation path (version snapshot, one undo step); when the section changed
// since the check it asks inline first. Dismiss hides a criterion for this
// check (kept in localStorage); "Show dismissed (n)" brings them back.
//
// On open, and whenever the target or its nonce changes, the panel saves, shows
// the stored result for the scope at once (GET), then asks for a check (POST
// without force, so unchanged text comes back cached). When the stored result
// is still current for the editor's text, that request runs quietly (no
// "Checking for changes…" unless it turns out to need the model). "Check
// again" forces a new one. Pure logic lives in check-panel-model.ts.

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, RefreshCw } from "@/components/icons";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { RubricCheckResponseShape, textFingerprint, type CheckEvidence, type RubricCheckResponse, type RubricCheckResult } from "@/lib/rubric/contract";
import {
  applyState,
  CHANGED_CONFIRM,
  changedSections,
  checkedText,
  checkErrorText,
  checkingText,
  dismissKey,
  findQuote,
  focusAfterDismiss,
  groupResults,
  levelDescriptor,
  QUIET_CHECK_GRACE_MS,
  storedIsCurrent,
  levelPips,
  levelText,
  loadDismissed,
  needsConfirm,
  saveDismissed,
  scopeText,
  summaryText,
  toggleDismissed,
  type TextRun,
} from "./check-panel-model";
import { PanelHeader } from "./side-panels";
import { sectionBodyRange } from "./tracked-range";
import type { GenerationRequest } from "./use-section-generation";

/** What to check: the whole document or one section. `nonce` changes on every request, so asking again re-runs. */
export type CheckTarget = { scope: "document"; nonce: number } | { scope: "section"; sectionId: string; nonce: number };

export type CheckPanelProps = {
  editor: Editor;
  documentId: string | null;
  target: CheckTarget;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** The section generation runner (snapshot first, one undo step, prompt if the section changed while running). */
  run: (req: GenerationRequest) => Promise<string | null>;
  /** Sections being written now (Apply is disabled for them). */
  busy: ReadonlySet<string>;
  /** Scroll a section's heading into view (an evidence quote's section). */
  onJumpToSection: (sectionId: string) => void;
  onClose: () => void;
};

/** localStorage, or null where it is blocked (private windows, sandboxed previews). */
function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The editor's fingerprint of a section's body, or null when it is gone. */
function editorFingerprint(editor: Editor, sectionId: string): string | null {
  if (editor.isDestroyed) return null;
  const s = sectionBodyRange(editor.state.doc, sectionId);
  return s ? textFingerprint(s.bodyText) : null;
}

const smallButton =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--doc-line)] px-2.5 text-xs font-semibold hover:border-[var(--doc-accent)] hover:text-[var(--doc-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] disabled:opacity-40 sm:min-h-8";
const primaryButton =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 text-xs font-semibold text-[var(--doc-on-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] disabled:opacity-40 sm:min-h-8";

export function CheckPanel({ editor, target, ensureSaved, run, busy, onJumpToSection, onClose }: CheckPanelProps) {
  const [result, setResult] = useState<RubricCheckResponse | null>(null);
  /** "loading": reading the stored result; "checking": the check itself is running; "quiet": refreshing a result that is still current. */
  const [phase, setPhase] = useState<"loading" | "checking" | "quiet" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  /** A soft message shown above a result that is still useful (a 429 after a cached result). */
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<string[]>(() => loadDismissed(safeStorage()));
  const [showDismissed, setShowDismissed] = useState(false);
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Re-render on edits (debounced) so staleness and Apply follow the text.
  const [, setDocVersion] = useState(0);

  const sectionId = target.scope === "section" ? target.sectionId : null;
  // The latest props for the request runner, so the effect re-runs only on a new target.
  // (Every check saves first, so the stored document matches the editor; documentId isn't needed.)
  const latest = useRef({ ensureSaved, target, editor });
  latest.current = { ensureSaved, target, editor };
  const resultRef = useRef(result);
  resultRef.current = result;
  const seq = useRef(0);

  // Opened from a button that this panel replaced (Tools' Check document), focus
  // would drop to <body>: start it at the panel's title instead. After a frame,
  // so a menu that restores focus to its trigger keeps it.
  const titleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) titleRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  /** Where focus goes after a Dismiss removes the focused criterion: the next one's disclosure button, else the dismissed toggle. */
  const toggleButtons = useRef(new Map<string, HTMLButtonElement>());
  const dismissedToggleRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ criterion: string } | "dismissed" | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    (target === "dismissed" ? dismissedToggleRef.current : toggleButtons.current.get(target.criterion))?.focus();
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setDocVersion((v) => v + 1), 400);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  const check = useCallback(async (force: boolean, readStored: boolean) => {
    const my = ++seq.current;
    const { ensureSaved: save, target: t, editor: ed } = latest.current;
    setError(null);
    setNotice(null);
    setPhase(readStored ? "loading" : "checking");
    const stale = () => my !== seq.current;
    let grace: ReturnType<typeof setTimeout> | null = null;
    try {
      const id = await save();
      if (stale()) return;
      if (!id) {
        setError("Save the document first.");
        return;
      }
      if (readStored) {
        const qs = t.scope === "section" ? `?sectionId=${encodeURIComponent(t.sectionId)}` : "";
        const res = await fetch(`/api/documents/${id}/check${qs}`, { cache: "no-store" }).catch(() => null);
        const parsed = res?.ok ? RubricCheckResponseShape.safeParse(await res.json().catch(() => null)) : null;
        if (stale()) return;
        if (parsed?.success) setResult(parsed.data);
        // The stored result still matches the text (it was just saved): refresh it quietly,
        // saying "Checking for changes…" only if the request runs long enough to be a new check.
        const ids = t.scope === "document" && !ed.isDestroyed ? listSections(ed.getJSON() as PMNode, { own: true }).map((x) => x.sectionId).filter(Boolean) : null;
        const current = !force && !!parsed?.success && storedIsCurrent(parsed.data.sectionFingerprints, (sid) => editorFingerprint(ed, sid), ids);
        setPhase(current ? "quiet" : "checking");
        if (current) grace = setTimeout(() => !stale() && setPhase("checking"), QUIET_CHECK_GRACE_MS);
      }
      const body = t.scope === "section" ? { scope: "section", sectionId: t.sectionId, force } : { scope: "document", force };
      let res: Response;
      try {
        res = await fetch(`/api/documents/${id}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        if (!stale()) setError("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      const out: unknown = await res.json().catch(() => null);
      if (stale()) return;
      if (!res.ok) {
        const message = checkErrorText(res.status, out as { error?: unknown; retryAfterSeconds?: unknown } | null);
        // A result on screen is still worth reading: a rate limit only adds a note.
        if (res.status === 429 && resultRef.current) setNotice(message);
        else setError(message);
        return;
      }
      const parsed = RubricCheckResponseShape.safeParse(out);
      if (!parsed.success) {
        setError("The check returned something unexpected. Try again.");
        return;
      }
      setResult(parsed.data);
      setApplied(new Set());
      setConfirming(null);
    } finally {
      if (grace) clearTimeout(grace);
      if (!stale()) setPhase(null);
    }
  }, []);

  useEffect(() => {
    setResult(null);
    setExpanded(new Set());
    setApplied(new Set());
    setConfirming(null);
    setShowDismissed(false);
    void check(false, true);
    const requests = seq;
    return () => {
      // A response for this target that arrives after it changed is ignored.
      requests.current++;
    };
  }, [check, target.nonce, target.scope, sectionId]);

  const fingerprint = (id: string) => editorFingerprint(editor, id);
  const changed = result ? changedSections(result.sectionFingerprints, fingerprint) : [];
  const stale = !!result && (changed.length > 0 || applied.size > 0);
  const headingNow = sectionId ? (sectionBodyRange(editor.state.doc, sectionId)?.heading ?? null) : null;
  const checking = phase !== null && phase !== "quiet";
  const working = checkingText(phase, !!result);

  const dismissedKeys = new Set(dismissed);
  const isDismissed = (r: RubricCheckResult) => !!result && dismissedKeys.has(dismissKey(result.inputsHash, r.criterion));
  const visible = result ? result.results.filter((r) => showDismissed || !isDismissed(r)) : [];
  const dismissedCount = result ? result.results.filter(isDismissed).length : 0;

  const setDismissedFor = (r: RubricCheckResult, on: boolean) => {
    if (!result) return;
    if (on && !showDismissed) {
      // The criterion leaves the list with the focused Dismiss button: move to its neighbour.
      const next = focusAfterDismiss(visible, r.criterion);
      pendingFocus.current = next ? { criterion: next } : "dismissed";
    }
    const next = toggleDismissed(dismissed, dismissKey(result.inputsHash, r.criterion), on);
    setDismissed(next);
    saveDismissed(safeStorage(), next);
  };

  const toggle = (criterion: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(criterion)) next.delete(criterion);
      else next.add(criterion);
      return next;
    });

  /** Select the quote in the editor when it is found (in its section, else anywhere); otherwise go to the section. */
  const showEvidence = (e: CheckEvidence) => {
    if (editor.isDestroyed) return;
    const doc = editor.state.doc;
    const range = e.sectionId ? sectionBodyRange(doc, e.sectionId) : null;
    const runs: TextRun[] = [];
    doc.nodesBetween(range?.from ?? 0, range?.to ?? doc.content.size, (node, pos) => {
      if (node.isText && node.text) runs.push({ text: node.text, pos });
    });
    const found = findQuote(runs, e.quote);
    if (found) editor.chain().focus().setTextSelection(found).scrollIntoView().run();
    else if (e.sectionId) onJumpToSection(e.sectionId);
  };

  const apply = async (r: RubricCheckResult) => {
    if (!r.fixSectionId) return;
    setConfirming(null);
    setApplying(r.criterion);
    const err = await run({ sectionId: r.fixSectionId, mode: "rewrite", instruction: r.fix });
    setApplying(null);
    // Errors are shown by the runner's own notice.
    if (!err) setApplied((s) => new Set(s).add(r.criterion));
  };

  const requestApply = (r: RubricCheckResult) => {
    if (!result || !r.fixSectionId) return;
    if (needsConfirm(result.sectionFingerprints[r.fixSectionId], fingerprint(r.fixSectionId))) setConfirming(r.criterion);
    else void apply(r);
  };

  return (
    <aside aria-label="Check" className="flex h-full flex-col">
      <PanelHeader title="Check" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p ref={titleRef} tabIndex={-1} className="text-sm font-semibold outline-none">{scopeText(target.scope, headingNow ?? result?.results.find((r) => r.fixSectionId === sectionId)?.fixSectionHeading ?? null)}</p>
            {result && <p className="text-xs text-[var(--doc-muted)]">{checkedText(result.checkedAt)}</p>}
          </div>
          <button type="button" onClick={() => void check(true, false)} disabled={checking} className={smallButton}>
            {phase === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Check again
          </button>
        </div>

        <div aria-live="polite" className="space-y-2 empty:hidden">
          {working && (
            <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {working}
            </p>
          )}
          {notice && <p className="rounded-md bg-[var(--doc-accent-soft)] px-2.5 py-2 text-sm">{notice}</p>}
          {stale && !checking && (
            <p className="rounded-md bg-amber-50 px-2.5 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {applied.size > 0 ? "Fixes were applied since this check." : "The text changed since this check."} Check again to rescore.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {result && (
          <>
            <p className="text-sm text-[var(--doc-muted)]">{summaryText(result.results)}</p>
            {groupResults(visible).map((g) => (
              <GroupSection key={g.key} label={g.label} count={g.results.length}>
                {g.results.map((r) => {
                  const exists = !!r.fixSectionId && !!sectionBodyRange(editor.state.doc, r.fixSectionId);
                  const state = applyState(r, { sectionExists: exists, busy: !!r.fixSectionId && (busy.has(r.fixSectionId) || applying !== null) });
                  return (
                    <CriterionItem
                      key={r.criterion}
                      toggleRef={(el) => {
                        if (el) toggleButtons.current.set(r.criterion, el);
                        else toggleButtons.current.delete(r.criterion);
                      }}
                      result={r}
                      open={expanded.has(r.criterion)}
                      onToggle={() => toggle(r.criterion)}
                      applyEnabled={state.enabled}
                      applyReason={state.reason}
                      applying={applying === r.criterion}
                      applied={applied.has(r.criterion)}
                      confirming={confirming === r.criterion}
                      dismissed={isDismissed(r)}
                      onEvidence={showEvidence}
                      onApply={() => requestApply(r)}
                      onConfirm={() => void apply(r)}
                      onCancelConfirm={() => setConfirming(null)}
                      onDismiss={(on) => setDismissedFor(r, on)}
                    />
                  );
                })}
              </GroupSection>
            ))}
            {dismissedCount > 0 && (
              <button ref={dismissedToggleRef} type="button" onClick={() => setShowDismissed((v) => !v)} aria-pressed={showDismissed} className="text-sm font-medium text-[var(--doc-accent)] underline-offset-2 hover:underline">
                {showDismissed ? "Hide dismissed" : `Show dismissed (${dismissedCount})`}
              </button>
            )}
            {result.droppedEvidence > 0 && (
              <p className="text-xs text-[var(--doc-muted)]">
                {result.droppedEvidence === 1 ? "1 quote" : `${result.droppedEvidence} quotes`} couldn&apos;t be found in the document and {result.droppedEvidence === 1 ? "was" : "were"} left out.
              </p>
            )}
            <p className="text-xs text-[var(--doc-muted)]">Apply rewrites the section with the fix. A snapshot is saved first, and Undo reverses it.</p>
          </>
        )}
      </div>
    </aside>
  );
}

function GroupSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2 border-t border-[var(--doc-line)] pt-3">
      <h3 id={id} className="text-sm font-semibold">
        {label} <span className="font-normal text-[var(--doc-muted)]">({count})</span>
      </h3>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

/** "2 of 4" with one pip per level; the text carries the level, the pips only repeat it. */
function LevelScale({ result }: { result: RubricCheckResult }) {
  const pips = levelPips(result);
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--doc-muted)]" title={levelDescriptor(result)}>
      <span className="tabular-nums">
        <span className="sr-only">Level </span>
        {levelText(result)}
      </span>
      <span className="flex gap-0.5" aria-hidden>
        {pips.map((on, i) => (
          <span key={i} className={`h-1.5 w-3 rounded-full ${on ? "bg-[var(--doc-accent)]" : "bg-[var(--doc-line)]"}`} />
        ))}
      </span>
    </span>
  );
}

function CriterionItem(props: {
  toggleRef: (el: HTMLButtonElement | null) => void;
  result: RubricCheckResult;
  open: boolean;
  onToggle: () => void;
  applyEnabled: boolean;
  applyReason: string | null;
  applying: boolean;
  applied: boolean;
  confirming: boolean;
  dismissed: boolean;
  onEvidence: (e: CheckEvidence) => void;
  onApply: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onDismiss: (on: boolean) => void;
}) {
  const { result: r, open, confirming } = props;
  const panelId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    // Apply anyway and Cancel unmount the focused button with the group: back
    // to Apply (Cancel), or to the criterion while the fix runs (Apply is disabled).
    else if (wasConfirming.current) {
      const active = document.activeElement;
      if (!active || active === document.body) (applyRef.current && !applyRef.current.disabled ? applyRef.current : toggleRef.current)?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);
  const descriptor = levelDescriptor(r);

  return (
    <li className={`rounded-lg border border-[var(--doc-line)] ${props.dismissed ? "opacity-70" : ""}`}>
      <button
        ref={(el) => {
          toggleRef.current = el;
          props.toggleRef(el);
        }}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={props.onToggle} className="flex min-h-11 w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--doc-accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]">
        <ChevronRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--doc-muted)] transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-medium leading-snug">{r.label}</span>
          <LevelScale result={r} />
        </span>
        {props.applied && <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">Applied</span>}
        {props.dismissed && <span className="shrink-0 rounded-full bg-[var(--doc-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--doc-muted)]">Dismissed</span>}
      </button>
      {open && (
        <div id={panelId} className="space-y-3 px-3 pb-3 pl-8 text-sm">
          {descriptor && <p className="text-xs text-[var(--doc-muted)]">{descriptor}</p>}
          {r.rationale && <p>{r.rationale}</p>}
          {r.evidence.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Evidence</h4>
              <ul className="space-y-1">
                {r.evidence.map((e, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => props.onEvidence(e)} className="w-full rounded-md border-l-2 border-[var(--doc-accent)] bg-[var(--doc-accent-soft)] px-2.5 py-1.5 text-left text-xs hover:text-[var(--doc-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]">
                      <span className="line-clamp-3">“{e.quote}”</span>
                      {e.heading && <span className="mt-0.5 block text-[var(--doc-muted)]">In {e.heading}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.fix && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Fix{r.fixSectionHeading ? ` · ${r.fixSectionHeading}` : ""}</h4>
              <p>{r.fix}</p>
              {confirming ? (
                <div role="group" aria-label="Confirm applying the fix" className="space-y-2 rounded-md bg-amber-50 px-2.5 py-2 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                  <p>{CHANGED_CONFIRM}</p>
                  <div className="flex flex-wrap gap-2">
                    <button ref={confirmRef} type="button" onClick={props.onConfirm} className={primaryButton}>
                      Apply anyway
                    </button>
                    <button type="button" onClick={props.onCancelConfirm} className={smallButton}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {!props.dismissed && (
                    <button ref={applyRef} type="button" onClick={props.onApply} disabled={!props.applyEnabled} title={props.applyReason ?? undefined} className={primaryButton}>
                      {props.applying && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} {props.applied ? "Apply again" : "Apply"}
                    </button>
                  )}
                  <button type="button" onClick={() => props.onDismiss(!props.dismissed)} className={smallButton}>
                    {props.dismissed ? "Restore" : "Dismiss"}
                  </button>
                  {!props.applyEnabled && props.applyReason && !props.dismissed && <span className="basis-full text-xs text-[var(--doc-muted)]">{props.applyReason}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
