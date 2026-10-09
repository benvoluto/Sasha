// The verbatim-overlap check (PLAN §6.11: "a check flags long verbatim
// overlaps"). Guidance must describe the example's pattern, never copy its
// sentences: any run of at least OVERLAP_MIN_WORDS consecutive words that a
// draft string shares with an example is flagged, after both are normalized
// for case, punctuation and whitespace.
//
// Also the walk over every string in a draft (type, workflow, requirement
// sets) with a readable path, shared with the personal-detail check
// (personal.ts) and used to apply "remove" on a flag.
//
// Pure and client-safe: the extraction, the save route and the review screen
// all run it.

import { OVERLAP_MIN_WORDS, type LearnDraft, type OverlapFlag } from "./contract";

export type DraftParts = Pick<LearnDraft, "type" | "workflow" | "requirementSets">;

/**
 * Fields that hold keys, identifiers, wiring or enums rather than prose: not
 * walked (a key can't copy a sentence or hold a name, and rewriting one would
 * break the draft).
 */
const SKIP_KEYS = new Set(["key", "id", "node", "in", "version", "provenance", "appliesTo", "aliases", "renderer", "kind", "unit", "level", "order", "family", "params", "requirementSets", "specKeys", "sectionKeys", "fromSpecKeys", "toSpecKeys", "criteriaFrom", "requirement", "requirementSet", "from", "scope", "against", "severity", "editable", "records", "mode"]);

/** An array element's path segment: its key or id when it has one (sections, rubric, steps, items), else its index. */
function segment(item: unknown, index: number): string {
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    if (typeof o.key === "string" && o.key) return o.key;
    if (typeof o.id === "string" && o.id) return o.id;
  }
  return String(index);
}

/**
 * "values" is a list of keys in step.decide, enum fields and scales (skipped),
 * but a list of {key, label, description} in the workflow's outcome, whose
 * label and description are prose shown in every run (walked).
 */
const skipped = (k: string, v: unknown) => SKIP_KEYS.has(k) || (k === "values" && !(Array.isArray(v) && v.some((x) => x && typeof x === "object")));

function mapValue(value: unknown, path: string, fn: (path: string, value: string) => string): unknown {
  if (typeof value === "string") return fn(path, value);
  if (Array.isArray(value)) return value.map((v, i) => mapValue(v, `${path}.${segment(v, i)}`, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = skipped(k, v) ? v : mapValue(v, `${path}.${k}`, fn);
    return out;
  }
  return value;
}

/**
 * A copy of the draft with every prose string passed through `fn(path, value)`.
 * Paths read "type.sections.<key>.guidance", "type.rubric.<key>.levels.0.descriptor",
 * "workflow.steps.<id>.config.instructions", "requirements.<set>.items.<item>.text".
 */
export function mapDraftStrings<T extends Partial<DraftParts>>(draft: T, fn: (path: string, value: string) => string): T {
  const out = { ...draft };
  if (draft.type) out.type = mapValue(draft.type, "type", fn) as DraftParts["type"];
  if (draft.workflow) out.workflow = mapValue(draft.workflow, "workflow", fn) as DraftParts["workflow"];
  if (draft.requirementSets) out.requirementSets = draft.requirementSets.map((s) => mapValue(s, `requirements.${s.key}`, fn)) as DraftParts["requirementSets"];
  return out;
}

/** Every prose string in the draft with its path. */
export function draftStrings(draft: Partial<DraftParts>): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  mapDraftStrings(draft, (path, value) => {
    out.push({ path, value });
    return value;
  });
  return out;
}

// --- Words -------------------------------------------------------------------------

type Token = { word: string; start: number; end: number };

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Words with their offsets, lowercased and without apostrophes ("Don’t" and "dont" match). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.normalize("NFKC").matchAll(WORD_RE)) out.push({ word: m[0].toLowerCase().replace(/['’]/g, ""), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** Every run of `n` consecutive words in a text, joined by single spaces. */
export function shingles(text: string, n = OVERLAP_MIN_WORDS): Set<string> {
  const words = tokenize(text).map((t) => t.word);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** The maximal runs of `value` (word index ranges) that share at least `n` consecutive words with the example. */
function copiedRuns(tokens: Token[], example: Set<string>, n: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    const key = tokens
      .slice(i, i + n)
      .map((t) => t.word)
      .join(" ");
    if (!example.has(key)) continue;
    const last = runs.at(-1);
    // Overlapping (or touching) windows are one copied run.
    if (last && i <= last[1]) last[1] = i + n;
    else runs.push([i, i + n]);
  }
  return runs;
}

/**
 * Every copied run in the draft: a draft string that shares at least `n`
 * consecutive (normalized) words with an example. One flag per run; a run
 * found in several examples is reported for the first.
 */
export function findOverlaps(draft: Partial<DraftParts>, examples: string[], n = OVERLAP_MIN_WORDS): OverlapFlag[] {
  const indexes = examples.map((e) => shingles(e, n));
  const flags: OverlapFlag[] = [];
  const seen = new Set<string>();
  for (const { path, value } of draftStrings(draft)) {
    const tokens = tokenize(value);
    if (tokens.length < n) continue;
    indexes.forEach((index, example) => {
      for (const [a, b] of copiedRuns(tokens, index, n)) {
        const text = value.slice(tokens[a].start, tokens[b - 1].end);
        const id = `${path}\u0000${text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        flags.push({ path, text, words: b - a, example });
      }
    });
  }
  return flags;
}

/** What a field reads after "Remove" took out all of its text. */
export const REWRITE_NOTE = "Describe this in your own words.";

/** Tidy the gap a removed run leaves: doubled spaces, a space before punctuation, empty brackets. */
function tidy(s: string): string {
  return s
    .replace(/\(\s*\)|\[\s*\]|“\s*”|"\s*"/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.,;:])\1+/g, "$1")
    .trim();
}

/** "Remove" on an overlap flag: the copied run taken out of its field (REWRITE_NOTE if nothing is left). */
export function removeOverlap<T extends Partial<DraftParts>>(draft: T, flag: Pick<OverlapFlag, "path" | "text">): T {
  return mapDraftStrings(draft, (path, value) => {
    if (path !== flag.path || !value.includes(flag.text)) return value;
    const left = tidy(value.split(flag.text).join(" "));
    return tokenize(left).length ? left : REWRITE_NOTE;
  });
}

/** The flags the author has not chosen to keep (a kept path covers every flag on it). */
export function unacknowledgedOverlaps(flags: OverlapFlag[], keepPaths: string[]): OverlapFlag[] {
  const keep = new Set(keepPaths);
  return flags.filter((f) => !keep.has(f.path));
}
