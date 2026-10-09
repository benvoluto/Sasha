// Checking the [[p:ID]] markers in a model reply against the passages they
// name (phase7-spec.md §2.2), before the reply reaches the editor. A marker is
// kept only when its id is well formed, the passage exists for the caller's
// team, its source is linked to the document, and any words it quotes are in
// the passage. Kept markers are rewritten to the bare form; everything else is
// removed and reported, so the editor never shows a citation nobody checked.
//
// Server-only (groundingResolver reads the stores). verifyMarkers and the
// wording guard are pure apart from the resolver they are given.

import type { Grounding } from "@/lib/sections/grounding";
import { passagePrefix } from "@/lib/sources/pages";
import { listDocumentSources, listPassages, listSources, type StoredPassage } from "@/lib/sources/store";
import {
  LEFTOVER_MARKER_RE,
  MAX_CITATION_EXCERPT,
  parseMarkers,
  PASSAGE_ID_RE,
  type CitationInfo,
  type CitationReport,
  type DropReason,
  type DroppedMarker,
  type PassageResolver,
  type ResolvedPassage,
  type VerifiedMarkdown,
} from "./contract";
import { passageIndex } from "./references";
import { quoteKey, quoteMatches } from "./quote";

export { quoteKey, quoteMatches };

/** Passage ids the model copied as bracketed text ("[S1a2b3c4d.P7]", sometimes doubled), not as markers. */
const STRAY_ID_RE = /[ \t]?\[\[?S[0-9a-fA-F]{8}\.P\d{1,6}\]\]?/g;

const isHeadingLine = (line: string) => /^ {0,3}#{1,6}(\s|$)/.test(line);
/** A GFM table row or separator: the converter reads pipe-led and pipe-ended lines as table rows. */
const isTableLine = (line: string) => /^\s*\|/.test(line) || /\|\s*$/.test(line);

const excerpt = (s: string) => (s.length > MAX_CITATION_EXCERPT ? `${s.slice(0, MAX_CITATION_EXCERPT - 1).trimEnd()}…` : s);

/** The offsets of each line's start, so a marker's line can be found by its index. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

function lineAt(text: string, starts: number[], index: number): string {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  const end = text.indexOf("\n", starts[lo]);
  return text.slice(starts[lo], end < 0 ? text.length : end);
}

/**
 * Check every marker in `markdown` (phase7-spec.md §2.2): malformed ids,
 * markers in headings or table rows, unknown passages, sources not linked to
 * the document and quotes the passage doesn't contain are removed (with one
 * preceding space) and listed in `report.dropped`; the rest become bare
 * `[[p:ID]]`, with runs of the same marker collapsed. Stray bracketed passage
 * ids are stripped without a record.
 */
export async function verifyMarkers(markdown: string, resolve: PassageResolver): Promise<VerifiedMarkdown> {
  const text = markdown.replace(STRAY_ID_RE, "");
  const markers = parseMarkers(text);
  const report: CitationReport = { kept: 0, dropped: [], passages: {} };
  if (!markers.length) return { markdown: sweepLeftovers(text, report), report };

  const starts = lineStarts(text);
  const cache = new Map<string, Promise<ResolvedPassage | null>>();
  const lookup = (id: string) => {
    if (!cache.has(id)) cache.set(id, resolve(id).catch(() => null));
    return cache.get(id)!;
  };

  let out = "";
  let cursor = 0;
  for (const m of markers) {
    const line = lineAt(text, starts, m.index);
    let reason: DropReason | null = null;
    let passage: ResolvedPassage | null = null;
    if (!PASSAGE_ID_RE.test(m.passageId) || isHeadingLine(line) || isTableLine(line)) reason = "malformed";
    else {
      passage = await lookup(m.passageId);
      if (!passage) reason = "unknown_passage";
      else if (!passage.linked) reason = "not_linked";
      else if (m.quote && !quoteMatches(m.quote, passage.text)) reason = "quote_mismatch";
    }

    // Between two parsed markers, any "[[p:" is one the parser couldn't read.
    let before = sweepLeftovers(text.slice(cursor, m.index), report);
    if (reason || !passage) {
      // Removed with one preceding space, so "rose 12% [[p:x]]." reads "rose 12%.".
      if (/[ \t]$/.test(before)) before = before.slice(0, -1);
      out += before;
      report.dropped.push({ raw: m.raw, passageId: m.passageId, reason: reason ?? "unknown_passage" } satisfies DroppedMarker);
    } else {
      out += `${before}[[p:${passage.passageId}]]`;
      const info: CitationInfo = report.passages[passage.passageId] ?? {
        passageId: passage.passageId,
        sourceId: passage.sourceId,
        sourceTitle: passage.sourceTitle,
        page: passage.page,
        quote: null,
        excerpt: excerpt(passage.text),
      };
      // The first quote that matched wins.
      if (!info.quote && m.quote && quoteKey(m.quote)) info.quote = m.quote;
      report.passages[passage.passageId] = info;
    }
    cursor = m.index + m.length;
  }
  out += sweepLeftovers(text.slice(cursor), report);

  // The same passage cited twice in a row reads as one citation.
  const collapsed = out.replace(/(\[\[p:[^\]|]+\]\])(?:[ \t]*\1)+/g, "$1");
  report.kept = parseMarkers(collapsed).length;
  return { markdown: collapsed, report };
}

/**
 * Removes what is left of markers the parser couldn't read from text that
 * holds no parsed marker, and reports each as malformed, so every marker is either kept in bare form or dropped and
 * reported, never passed through as text.
 */
function sweepLeftovers(text: string, report: CitationReport): string {
  return text.replace(LEFTOVER_MARKER_RE, (raw) => {
    const passageId = /\[\[p:([^\]|]*)/.exec(raw)?.[1]?.trim() ?? "";
    report.dropped.push({ raw: raw.trimStart(), passageId, reason: "malformed" });
    return "";
  });
}

// --- The resolver ---------------------------------------------------------------

/** Most of the team's sources searched for an unlinked one (beyond this, it reads as unknown). */
export const UNLINKED_SEARCH_CAP = 200;

const titleOf = (s: { title: string | null; filename: string | null; url: string | null }) => s.title || s.filename || s.url || "Untitled source";

/**
 * A PassageResolver for one team and document. The passages the model was
 * shown (the grounding) are checked first; otherwise the source is found by
 * its id prefix among the document's linked sources, then (cheaply, capped)
 * among the team's other sources, which resolve as not linked. Every lookup
 * goes through `teamId`, so another team's passage is unknown. Cached per
 * resolver (make one per reply).
 */
export function groundingResolver(teamId: string, documentId: string, grounding: Pick<Grounding, "sources" | "passages">): PassageResolver {
  const shown = new Map(grounding.passages.map((p) => [p.id, p]));
  const shownSources = new Map(grounding.sources.map((s) => [passagePrefix(s.id), s]));
  let linked: Promise<Array<{ id: string; title: string }>> | null = null;
  let team: Promise<Array<{ id: string; title: string }>> | null = null;
  const passages = new Map<string, Promise<StoredPassage[]>>();

  const linkedSources = () =>
    (linked ??= listDocumentSources(teamId, documentId).then((l) => (l ?? []).map((s) => ({ id: s.id, title: titleOf(s) }))));
  const teamSources = () => (team ??= listSources(teamId, { limit: UNLINKED_SEARCH_CAP }).then((l) => l.map((s) => ({ id: s.id, title: titleOf(s) }))));
  const passagesOf = (sourceId: string) => {
    if (!passages.has(sourceId)) passages.set(sourceId, listPassages(teamId, sourceId).then((p) => p ?? []));
    return passages.get(sourceId)!;
  };
  const find = async (source: { id: string; title: string }, passageId: string, isLinked: boolean): Promise<ResolvedPassage | null> => {
    const idx = passageIndex(passageId);
    const p = (await passagesOf(source.id)).find((x) => x.id === passageId || (idx !== null && x.idx === idx));
    return p ? { passageId, sourceId: source.id, sourceTitle: source.title, page: p.page, text: p.text, linked: isLinked } : null;
  };

  return async (passageId) => {
    const prefix = passageId.split(".")[0];
    const p = shown.get(passageId);
    const src = shownSources.get(prefix);
    if (p && src) return { passageId, sourceId: src.id, sourceTitle: src.title, page: p.page, text: p.text, linked: true };

    const mine = (await linkedSources()).find((s) => passagePrefix(s.id) === prefix);
    if (mine) return find(mine, passageId, true);
    const other = (await teamSources()).find((s) => passagePrefix(s.id) === prefix);
    return other ? find(other, passageId, false) : null;
  };
}

// --- "Cite sources" wording guard -----------------------------------------------------

/** How much of the text the guard compares. */
export const WORDING_GUARD_CHARS = 20_000;
/** The share of characters "Cite sources" may change (markers aside) before the result is refused. */
export const WORDING_GUARD_RATIO = 0.02;
export const WORDING_CHANGED_ERROR = "Claude changed the wording; nothing was applied.";

/** Text as the guard compares it: markers and stray ids gone, light Markdown syntax gone, whitespace collapsed. */
export function guardText(s: string): string {
  return s
    .replace(/\[\[p:[^\]]*\]\]/g, "")
    .replace(STRAY_ID_RE, "")
    .split("\n")
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))
    .join("\n")
    .replace(/\*\*|__|\|/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
    .slice(0, WORDING_GUARD_CHARS);
}

/**
 * Pure: the Levenshtein distance between `a` and `b`, or `limit + 1` as soon as
 * it must exceed `limit` (a band of width 2·limit, so a long, nearly equal text
 * costs O(n·limit)).
 */
export function boundedLevenshtein(a: string, b: string, limit: number): number {
  // Common prefix and suffix cost nothing.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const x = a.slice(s, ea);
  const y = b.slice(s, eb);
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  if (!x.length || !y.length) return Math.max(x.length, y.length);
  const INF = limit + 1;
  let prev = new Array<number>(y.length + 1);
  let cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j <= limit ? j : INF;
  for (let i = 1; i <= x.length; i++) {
    const lo = Math.max(1, i - limit);
    const hi = Math.min(y.length, i + limit);
    // Only the band is computed; the cells just outside it read as "too far".
    cur[0] = i <= limit ? i : INF;
    cur[lo - 1] = lo - 1 === 0 ? cur[0] : INF;
    if (hi < y.length) cur[hi + 1] = INF;
    let best = lo === 1 ? cur[0] : INF;
    for (let j = lo; j <= hi; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      const v = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
      cur[j] = v > INF ? INF : v;
      if (cur[j] < best) best = cur[j];
    }
    if (best > limit) return INF;
    [prev, cur] = [cur, prev];
  }
  return Math.min(prev[y.length], INF);
}

/** Pure: did the reply change the body's wording by more than `ratio` (markers and light Markdown aside)? */
export function wordingChanged(body: string, reply: string, ratio = WORDING_GUARD_RATIO): boolean {
  const a = guardText(body);
  const b = guardText(reply);
  const limit = Math.floor(Math.max(a.length, b.length) * ratio);
  return boundedLevenshtein(a, b, limit) > limit;
}
