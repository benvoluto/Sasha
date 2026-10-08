// Splits a source's extracted text into citable passages that remember where
// they came from. Extraction marks pages with "--- Page N ---" (the model writes
// these, numbered across the whole file even when a PDF was read in chunks) and
// files with "=== Document: name ===" (written in code). Each stretch between
// markers is split into passages the way toPassages does it (whole sentences up
// to about 600 characters), except that no passage is ever longer than that: a
// CSV, list or table with no sentence ends is cut at line breaks instead. Each
// passage records its page and its character offsets into the stored extracted
// text, so a citation can be shown in place.
//
// Ids are "S<first 8 hex of the source id>.P<n>": stable for as long as the
// extracted text is, and unique across sources a document cites together.

import type { StoredPassage } from "./store";

const MARKER = /^[ \t]*(?:===\s*Document:\s*(.+?)\s*===|---\s*Page\s+(\d+)\s*---)[ \t]*$/gim;

export function passagePrefix(sourceId: string): string {
  return `S${sourceId.replace(/-/g, "").slice(0, 8)}`;
}

type Segment = { start: number; end: number; page: number | null };

function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let page: number | null = null;
  let cursor = 0;
  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0;
    if (at > cursor) out.push({ start: cursor, end: at, page });
    // A new document starts unpaged until its first page marker.
    page = m[2] ? Number(m[2]) : null;
    cursor = at + m[0].length;
  }
  if (cursor < text.length) out.push({ start: cursor, end: text.length, page });
  return out;
}

/** Longest passage, in collapsed characters; matches toPassages' target. */
const PASSAGE_CHARS = 600;

/**
 * Only this much of a source's text is split into passages. Gemini's reads are
 * far shorter; this bounds a huge text or CSV upload read directly.
 */
export const MAX_PASSAGE_TEXT_CHARS = 2_000_000;

/** Where a sentence may end: after . ! or ? and before something sentence-like (as toPassages). */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g;

const WS = /\s/;
/** Same whitespace as \s, with a fast path for ASCII. */
function isSpace(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return WS.test(c);
}

/** Collapsed length of text[start, end), whitespace runs counting as one space. */
function collapsedLength(text: string, start: number, end: number): number {
  let n = 0;
  let inSpace = false;
  for (let i = start; i < end; i++) {
    if (isSpace(text[i])) {
      if (!inSpace) n++;
      inSpace = true;
    } else {
      n++;
      inSpace = false;
    }
  }
  return n;
}

/** First index in text[start, end) at which the collapsed length passes `max`, or end. */
function rawIndexAt(text: string, start: number, end: number, max: number): number {
  let n = 0;
  let inSpace = false;
  for (let i = start; i < end; i++) {
    const space = isSpace(text[i]);
    if (!space || !inSpace) n++;
    inSpace = space;
    if (n > max) return i;
  }
  return end;
}

/** Narrow [start, end) to exclude leading and trailing whitespace. */
function trimSpan(text: string, start: number, end: number): [number, number] {
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  return [start, end];
}

/**
 * Cut one over-long sentence into pieces of at most PASSAGE_CHARS: at the last
 * line break past the halfway point (so CSV rows and list items stay whole),
 * else at the last space, else mid-word.
 */
function* cutLong(text: string, start: number, end: number): Generator<[number, number]> {
  while (start < end) {
    const limit = rawIndexAt(text, start, end, PASSAGE_CHARS);
    if (limit >= end) {
      yield [start, end];
      return;
    }
    const half = start + Math.floor((limit - start) / 2);
    // Look back no further than halfway (lastIndexOf would scan to the start).
    let cut = limit;
    while (cut > half && text[cut] !== "\n") cut--;
    if (cut <= half) {
      cut = limit;
      while (cut > half && !isSpace(text[cut])) cut--;
      // Mid-word as a last resort, but never between the halves of a surrogate pair.
      if (cut <= half) cut = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
    }
    const [s, e] = trimSpan(text, start, cut);
    if (e > s) yield [s, e];
    [start, end] = trimSpan(text, cut, end);
  }
}

/** Sentences of text[start, end) as trimmed spans, none longer than PASSAGE_CHARS. */
function* units(text: string, start: number, end: number): Generator<[number, number]> {
  const emit = function* (a: number, b: number) {
    const [s, e] = trimSpan(text, a, b);
    if (e > s) yield* cutLong(text, s, e);
  };
  // Search only this segment, so text with no sentence ends isn't rescanned per page.
  let from = start;
  for (const m of text.slice(start, end).matchAll(SENTENCE_END)) {
    const at = start + (m.index ?? 0);
    yield* emit(from, at);
    from = at + m[0].length;
  }
  yield* emit(from, end);
}

export function pagedPassages(sourceId: string, extracted: string): StoredPassage[] {
  const prefix = passagePrefix(sourceId);
  const text = extracted.length > MAX_PASSAGE_TEXT_CHARS ? extracted.slice(0, MAX_PASSAGE_TEXT_CHARS) : extracted;
  const out: StoredPassage[] = [];
  const push = (page: number | null, start: number, end: number) => {
    const idx = out.length;
    out.push({ id: `${prefix}.P${idx}`, idx, page, start_offset: start, end_offset: end, text: text.slice(start, end).replace(/\s+/g, " ") });
  };
  for (const seg of segments(text)) {
    // Pack whole sentences (or pieces of over-long ones) up to PASSAGE_CHARS, as
    // toPassages does; each passage is one contiguous stretch of the raw text.
    let first = -1;
    let last = -1;
    let length = 0;
    for (const [s, e] of units(text, seg.start, seg.end)) {
      const n = collapsedLength(text, s, e);
      if (first >= 0 && length + 1 + n > PASSAGE_CHARS) {
        push(seg.page, first, last);
        first = -1;
      }
      if (first < 0) {
        first = s;
        length = n;
      } else {
        length += 1 + n;
      }
      last = e;
    }
    if (first >= 0) push(seg.page, first, last);
  }
  return out;
}
