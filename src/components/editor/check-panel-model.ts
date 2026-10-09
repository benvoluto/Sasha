// Pure logic for the Check panel (check-panel.tsx): grouping criteria by how
// much work they need, the level scale in words, whether the result is stale
// against the editor, when Apply is allowed and when it must ask first, the
// messages for failed requests, and the dismissed fixes kept in localStorage.
// No React, no editor: the panel passes in what it read.

import type { RubricCheckResult } from "@/lib/rubric/contract";

// --- Groups -----------------------------------------------------------------------

export type CheckGroupKey = "needs_work" | "could_improve" | "strong";

export const CHECK_GROUP_LABELS: Record<CheckGroupKey, string> = { needs_work: "Needs work", could_improve: "Could improve", strong: "Strong" };

const GROUP_ORDER: CheckGroupKey[] = ["needs_work", "could_improve", "strong"];

/**
 * Needs work: level 2 or lower (below the top), or under half the scale.
 * Strong: the top level. Everything between could improve.
 */
export function groupOf(r: Pick<RubricCheckResult, "level" | "maxLevel">): CheckGroupKey {
  if ((r.level <= 2 && r.level < r.maxLevel) || r.level < r.maxLevel / 2) return "needs_work";
  return r.level >= r.maxLevel ? "strong" : "could_improve";
}

/** The non-empty groups in order, each sorted by level, lowest first (ties keep the rubric's order). */
export function groupResults<T extends Pick<RubricCheckResult, "level" | "maxLevel">>(results: T[]): Array<{ key: CheckGroupKey; label: string; results: T[] }> {
  return GROUP_ORDER.map((key) => ({
    key,
    label: CHECK_GROUP_LABELS[key],
    results: results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => groupOf(r) === key)
      .sort((a, b) => a.r.level - b.r.level || a.i - b.i)
      .map(({ r }) => r),
  })).filter((g) => g.results.length > 0);
}

/** "2 criteria at level 1–2 · 5 of 9 need attention" (attention: anything below the top level). */
export function summaryText(results: Array<Pick<RubricCheckResult, "level" | "maxLevel">>): string {
  if (!results.length) return "No criteria were scored.";
  const low = results.filter((r) => r.level <= 2 && r.level < r.maxLevel).length;
  const attention = results.filter((r) => r.level < r.maxLevel).length;
  return `${low} ${low === 1 ? "criterion" : "criteria"} at level 1–2 · ${attention} of ${results.length} need attention`;
}

/** "2 of 4". */
export const levelText = (r: Pick<RubricCheckResult, "level" | "maxLevel">) => `${r.level} of ${r.maxLevel}`;

/** The descriptor of the level reached, for the scale's text. */
export function levelDescriptor(r: Pick<RubricCheckResult, "level" | "levels">): string {
  return r.levels.find((l) => l.score === r.level)?.descriptor ?? "";
}

/** One pip per level from the lowest up, filled up to the level reached. */
export function levelPips(r: Pick<RubricCheckResult, "level" | "levels">): boolean[] {
  return [...r.levels].sort((a, b) => a.score - b.score).map((l) => l.score <= r.level);
}

// --- Scope and time ---------------------------------------------------------------

/** "Whole document", or "“Budget” section". */
export function scopeText(scope: "document" | "section", heading: string | null): string {
  return scope === "document" ? "Whole document" : `“${heading?.trim() || "Untitled"}” section`;
}

/** "Checked just now", "Checked 5 min ago", "Checked 3 h ago", else the date. */
export function checkedText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Checked just now";
  if (s < 3600) return `Checked ${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `Checked ${Math.floor(s / 3600)} h ago`;
  return `Checked ${new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

// --- Staleness and Apply ----------------------------------------------------------

/**
 * Sections whose text changed since the check: the editor's fingerprint
 * (null when the section is gone) differs from the server's.
 */
export function changedSections(fingerprints: Record<string, string>, current: (sectionId: string) => string | null): string[] {
  return Object.entries(fingerprints)
    .filter(([id, fp]) => current(id) !== fp)
    .map(([id]) => id);
}

/**
 * Pure: is the stored result still current for the editor? No section in it
 * changed, and (for the whole document, `sectionIds` the editor's sections)
 * no section was added since. The panel then shows it without "Checking for
 * changes…" and refreshes quietly (the server may still find a change the
 * fingerprints don't cover: the text before the first heading, a citation,
 * the type).
 */
export function storedIsCurrent(fingerprints: Record<string, string>, current: (sectionId: string) => string | null, sectionIds: string[] | null = null): boolean {
  if (changedSections(fingerprints, current).length) return false;
  return !sectionIds || sectionIds.every((id) => id in fingerprints);
}

/** A quiet refresh still running after this long has gone to the model: the panel then says it is checking. */
export const QUIET_CHECK_GRACE_MS = 2500;

/**
 * The line shown while the panel works, or null for none: "loading" reads the
 * stored result, "checking" runs a check, "quiet" refreshes a current result
 * (nothing shown).
 */
export function checkingText(phase: "loading" | "checking" | "quiet" | null, hasResult: boolean): string | null {
  if (phase === null || phase === "quiet") return null;
  if (hasResult) return "Checking for changes…";
  return phase === "loading" ? "Loading…" : "Checking against the rubric… this can take a minute.";
}

export type ApplyState = { enabled: boolean; reason: string | null };

/** Apply is off with no fix, no fix section, a deleted section, or one being written now. */
export function applyState(r: Pick<RubricCheckResult, "fix" | "fixSectionId">, opts: { sectionExists: boolean; busy: boolean }): ApplyState {
  if (!r.fix.trim()) return { enabled: false, reason: "No fix to apply." };
  if (!r.fixSectionId) return { enabled: false, reason: "This fix isn't about one section; make it by hand." };
  if (!opts.sectionExists) return { enabled: false, reason: "That section no longer exists." };
  if (opts.busy) return { enabled: false, reason: "Claude is writing this section." };
  return { enabled: true, reason: null };
}

/** Ask before applying when the section changed since the check (or the check has no fingerprint for it). */
export function needsConfirm(checked: string | undefined, now: string | null): boolean {
  return checked === undefined || checked !== now;
}

export const CHANGED_CONFIRM = "This section changed since the check. Apply the fix to the current text?";

// --- Errors -----------------------------------------------------------------------

/** The message for a failed check request. */
export function checkErrorText(status: number, body: { error?: unknown; retryAfterSeconds?: unknown } | null): string {
  const error = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : null;
  if (status === 429) {
    const n = Number(body?.retryAfterSeconds);
    return error ?? (Number.isFinite(n) && n > 0 ? `Checked moments ago. Try again in ${Math.ceil(n)}s.` : "Checked moments ago. Try again shortly.");
  }
  if (status === 413) return error ?? "This document is too long to check at once. Check one section at a time.";
  if (status === 503) return "Claude isn't set up on this server, so the check can't run.";
  if (status === 401 || status === 403) return error ?? "You don't have access to check this document.";
  if (status === 404) return error ?? "The document or section wasn't found. Save and try again.";
  return error ?? "The check failed. Try again.";
}

// --- Dismissed fixes --------------------------------------------------------------

export const DISMISSED_STORAGE_KEY = "sasha.check.dismissed";
/** Dismissals kept (newest last); older ones fall off. */
export const MAX_DISMISSED = 300;

/** Dismissals are per check: the inputs hash and the criterion. */
export const dismissKey = (inputsHash: string, criterion: string) => `${inputsHash.slice(0, 16)}:${criterion}`;

type ReadStore = Pick<Storage, "getItem"> | null | undefined;
type WriteStore = Pick<Storage, "setItem"> | null | undefined;

/** The saved dismissals; empty when storage is absent, blocked or holds something else. */
export function loadDismissed(store: ReadStore): string[] {
  try {
    const raw = store?.getItem(DISMISSED_STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(-MAX_DISMISSED) : [];
  } catch {
    return [];
  }
}

/** Save the dismissals (the newest MAX_DISMISSED); a storage failure is ignored. */
export function saveDismissed(store: WriteStore, keys: string[]): void {
  try {
    store?.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...new Set(keys)].slice(-MAX_DISMISSED)));
  } catch {
    // Private mode or a full quota: dismissals last for this panel only.
  }
}

/** Add or remove one dismissal, keeping order (newest last). */
export function toggleDismissed(keys: string[], key: string, dismissed: boolean): string[] {
  const rest = keys.filter((k) => k !== key);
  return dismissed ? [...rest, key] : rest;
}

// --- Finding a quote in the editor -------------------------------------------------

/** A text run of the editor's document between `from` and `to`: its text and where it starts. */
export type TextRun = { text: string; pos: number };

/**
 * Where `quote` sits among the text runs, matched case-insensitively with
 * whitespace and typographic quotes folded; null when it isn't there. Runs
 * are the document's text nodes in order (a quote may span marks, not blocks).
 */
export function findQuote(runs: TextRun[], quote: string): { from: number; to: number } | null {
  const fold = (c: string) => (/\s/.test(c) ? " " : c.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase());
  const needle = quote.replace(/…$/, "").split("").map(fold).join("").replace(/ +/g, " ").trim();
  if (needle.length < 3) return null;
  // Concatenate the runs (a space between runs that aren't contiguous), keeping each character's position.
  let hay = "";
  const pos: number[] = [];
  let lastEnd = -1;
  for (const r of runs) {
    if (lastEnd >= 0 && r.pos !== lastEnd && !hay.endsWith(" ")) {
      hay += " ";
      pos.push(-1);
    }
    for (let i = 0; i < r.text.length; i++) {
      const c = fold(r.text[i]);
      if (c === " " && hay.endsWith(" ")) continue;
      hay += c;
      pos.push(r.pos + i);
    }
    lastEnd = r.pos + r.text.length;
  }
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const start = pos.slice(at, at + needle.length).find((p) => p >= 0);
  const end = [...pos.slice(at, at + needle.length)].reverse().find((p) => p >= 0);
  return start === undefined || end === undefined ? null : { from: start, to: end + 1 };
}

/**
 * Pure: where focus goes when a Dismiss takes `criterion` out of the list (in
 * display order): the next criterion, else the previous one, else null (the
 * "Show dismissed" toggle).
 */
export function focusAfterDismiss<T extends Pick<RubricCheckResult, "criterion" | "level" | "maxLevel">>(visible: T[], criterion: string): string | null {
  const order = groupResults(visible).flatMap((g) => g.results);
  const i = order.findIndex((x) => x.criterion === criterion);
  if (i < 0) return null;
  return (order[i + 1] ?? order[i - 1])?.criterion ?? null;
}
