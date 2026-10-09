"use client";

// A replace_lines change, line by line (the resume Tailor step, tailor-spec.md
// §6.2): each proposed line with a checkbox (ticked by default), what it does
// (Rewrite, Move to top, Trim), the line as it was struck through and as it
// would read, why, the requirements it serves and the master passages behind
// it. "Apply N lines" applies only the ticked lines in the editor (one undo
// step, after a snapshot); the rest are recorded as rejected. When the run
// waits on this change, applying (or keeping none) lets it go on to score the
// resume as the author left it. Once the lines are applied but the result
// isn't recorded (the POST failed, or the save after them didn't land), the
// card locks the choice and offers "Record result" only: applying again would
// look for lines that are already changed.
//
// LineDiff and LineEvidence are shared with the checkpoint panel's read-only
// "Changed lines" list.

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { applyLinesLabel, evidenceLabel, lineSelectionText } from "@/components/editor/workflows-pane-model";
import type { EvidenceLink, ProposedChange, ReplaceLine, TailorLineAction } from "@/lib/workflow/contract";

const pill = "flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium sm:min-h-9";
const chip = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold";

export const ACTION_LABELS: Record<TailorLineAction, string> = { rewrite: "Rewrite", lead: "Move to top", trim: "Trim" };
const ACTION_TONE: Record<TailorLineAction, string> = {
  rewrite: "bg-[var(--doc-accent-soft)] text-[var(--doc-accent)]",
  lead: "bg-[var(--go-soft)] text-[var(--go)]",
  trim: "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
};

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The line as it was (struck through) and as it will read; a trim shows only the struck line, a move without new text only the line. */
export function LineDiff({ line }: { line: Pick<ReplaceLine, "action" | "original" | "proposed"> }) {
  const moved = line.action === "lead" && (!line.proposed || line.proposed === line.original);
  if (moved) return <p className="text-sm leading-relaxed">{line.original}</p>;
  return (
    <p className="space-y-0.5 text-sm leading-relaxed">
      <del className="block text-[var(--doc-muted)] line-through decoration-[var(--doc-muted)]">
        <span className="sr-only">Was: </span>
        {line.original}
      </del>
      {line.action !== "trim" && (
        <ins className="block no-underline">
          <span className="sr-only">Now: </span>
          {line.proposed}
        </ins>
      )}
    </p>
  );
}

/** The master passages behind a line, folded: each passage's label (source, page, id) and its quote. */
export function LineEvidence({ links }: { links: EvidenceLink[] }) {
  if (!links.length) return null;
  return (
    <details className="text-xs">
      <summary className="flex min-h-11 cursor-pointer items-center sm:min-h-8">
        Evidence ({links.length} passage{links.length === 1 ? "" : "s"})
      </summary>
      <ul className="mt-1 space-y-1.5">
        {links.map((e, i) => (
          <li key={`${e.ref}:${i}`} className="rounded-lg border border-[var(--doc-line)] px-2.5 py-2">
            <span className="block font-medium">
              {evidenceLabel(e)}
              {!e.verified && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">Unverified</span>}
            </span>
            {e.quote ? <q className="block leading-relaxed">{e.quote}</q> : <span className="text-[var(--doc-muted)]">No quote stored.</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function LineChangeCard({
  change,
  lines,
  waiting,
  canApply,
  applied = null,
  requirementLabel,
  onApply,
  onDiscard,
}: {
  change: ProposedChange;
  lines: ReplaceLine[];
  /** The run waits at this change's doc.write step until it is applied or discarded. */
  waiting: boolean;
  canApply: boolean;
  /** The lines already applied in the editor whose result isn't recorded yet: shown ticked and locked, with "Record result". */
  applied?: ReadonlySet<string> | null;
  /** A requirement key's text (the key when it isn't known). */
  requirementLabel: (key: string) => string;
  /** Applies the ticked lines and records every line; resolves to an error message, or null. */
  onApply: (selected: Set<string>) => Promise<string | null>;
  /** Records the change as discarded, every line rejected. */
  onDiscard: () => Promise<string | null>;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(lines.map((l) => l.id)));
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: "apply" | "discard", fn: () => Promise<string | null>) => {
    setBusy(kind);
    setError(null);
    const err = await fn();
    setBusy(null);
    if (err) setError(err);
  };
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const chosen = applied ?? selected;
  const count = lines.filter((l) => chosen.has(l.id)).length;
  const disabled = !canApply || !!busy;
  const locked = disabled || !!applied;
  const idBase = `lines-${change.id.replace(/\W/g, "-")}`;

  return (
    <section aria-label={change.title} className="space-y-2 rounded-xl border border-[var(--go-line,var(--doc-line))] px-3 py-2.5">
      {waiting && (
        <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          Choose the lines to keep. The run goes on to score the resume as you leave it.
        </p>
      )}
      {applied && (
        <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          These lines are already in the document, but the result isn&apos;t recorded yet. Record it to go on.
        </p>
      )}
      <div className="space-y-0.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--go)]">Proposed lines</p>
        <p className="text-sm font-semibold">{change.title}</p>
        {change.summary && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{change.summary}</p>}
      </div>

      <fieldset aria-describedby={`${idBase}-count`} className="space-y-2">
        <legend className="sr-only">Lines to keep</legend>
        <ul className="space-y-2">
          {lines.map((l) => {
            const kept = chosen.has(l.id);
            // Not kept: a dashed border and a chip, never dimmed text (the author still reads the line to decide).
            return (
              <li key={l.id} className={`space-y-1 rounded-lg border px-2.5 py-2 ${kept ? "border-[var(--doc-line)]" : "border-dashed border-[var(--doc-muted)]"}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <label className="-ml-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--go)] sm:min-h-8">
                    <input type="checkbox" checked={kept} disabled={locked} onChange={(e) => toggle(l.id, e.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--go)]" />
                    {l.action === "trim" ? (
                      <span>
                        Trim<span className="sr-only">: {clip(l.original)}</span>
                      </span>
                    ) : (
                      <span>
                        Keep<span className="sr-only"> line: {clip(l.proposed || l.original)}</span>
                      </span>
                    )}
                  </label>
                  <span className={`${chip} ${ACTION_TONE[l.action]}`}>{ACTION_LABELS[l.action]}</span>
                  {!kept && <span className={`${chip} border border-[var(--doc-line)] text-[var(--doc-ink)]`}>Not kept</span>}
                  {l.heading && <span className="text-xs text-[var(--doc-muted)]">{l.heading}</span>}
                </div>
                <LineDiff line={l} />
                {l.reason && <p className="text-xs leading-relaxed text-[var(--doc-muted)]">{l.reason}</p>}
                {l.requirementKeys.length > 0 && (
                  <ul aria-label="Requirements it serves" className="flex flex-wrap gap-1">
                    {l.requirementKeys.map((k) => (
                      // The whole requirement, wrapped: it is what the author judges the line against.
                      <li key={k} className="max-w-full rounded-md bg-[var(--doc-accent-soft)] px-2 py-0.5 text-left text-[11px] leading-snug font-medium break-words text-[var(--doc-ink)]">
                        {requirementLabel(k)}
                      </li>
                    ))}
                  </ul>
                )}
                <LineEvidence links={l.evidence} />
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={locked} onClick={() => setSelected(new Set(lines.map((l) => l.id)))} className={`${pill} text-[var(--go)] hover:bg-[var(--go-soft)] disabled:opacity-40`}>
          Accept all
        </button>
        <button type="button" disabled={locked} onClick={() => setSelected(new Set())} className={`${pill} text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-40`}>
          Reject all
        </button>
        <span id={`${idBase}-count`} aria-live="polite" className="text-xs text-[var(--doc-muted)]">
          {lineSelectionText(count, lines.length)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => void act("apply", () => onApply(new Set(lines.filter((l) => chosen.has(l.id)).map((l) => l.id))))}
          title={canApply && count && !applied ? "Applies as one step you can undo; a version is saved first" : undefined}
          className="flex min-h-11 items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-40 sm:min-h-9"
        >
          {busy === "apply" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} {applied ? "Record result" : applyLinesLabel(count)}
        </button>
        {/* Once the lines are in the document, discarding would record a result the document contradicts. */}
        {!applied && (
          <button type="button" disabled={disabled} onClick={() => void act("discard", onDiscard)} className={`${pill} text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-40`}>
            {busy === "discard" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Discard
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
