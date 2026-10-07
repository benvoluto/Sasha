// Word-boundary-aware phrase matching for grounding-signal detection, with
// text normalization and negation scoping.
//
// Naive substring search false-positives on short trigger tokens embedded in
// longer words — e.g. the LEP factor's "ELL" matches inside "spelling", and
// "LEP" matches inside "slept". We anchor each phrase on non-word boundaries so
// only whole-token occurrences count.
//
// Two hazards this module exists to remove:
//
//  1. TYPOGRAPHY. PDF extraction emits curly apostrophes (U+2019), en/em dashes,
//     non-breaking spaces, and reflows phrases across line breaks. Matching a
//     trigger literally means "doesn't make eye contact" never matches
//     "doesn’t make eye contact", and "trouble making friends" never matches
//     across a newline. 54 trigger phrases contain an apostrophe.
//
//  2. NEGATION. A screening report that CLEARS a student ("no hearing loss
//     noted", "denies frequent absences", "cultural factors were ruled out")
//     contains the trigger phrase verbatim. Counting those as evidence inverts
//     the finding — and for an "immediate" severity factor that blocks the whole
//     determination. Each match is therefore tagged with a polarity; negated
//     mentions are still recorded as evidence (so the reviewer can see what the
//     packet said) but the rule cores count only affirmed ones.

export type Polarity = "affirmed" | "negated";
export type PhraseMatch = { index: number; length: number; polarity: Polarity };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonicalize text for matching: NFKC, fold typographic punctuation to ASCII,
 * and collapse all whitespace (including newlines) to single spaces.
 *
 * Apply this to a document ONCE when the document is built, so that match
 * offsets, excerpts, and the text being searched all refer to the same string.
 */
export function normalizeForMatching(text: string): string {
  return (text || "")
    .normalize("NFKC")
    // apostrophes / single quotes / primes
    .replace(/[‘’‚‛′ʼ]/g, "'")
    // double quotes
    .replace(/[“”„‟″]/g, '"')
    // hyphens, en/em dashes, minus
    .replace(/[‐‑‒–—―−]/g, "-")
    // ellipsis
    .replace(/…/g, "...")
    // non-breaking / exotic spaces, then all whitespace runs → one space
    .replace(/[   ​]/g, " ")
    .replace(/\s+/g, " ");
}

/** A trigger phrase as a regex source: normalized, escaped, whitespace-tolerant. */
function phrasePattern(phrase: string): string {
  return escapeRegExp(normalizeForMatching(phrase).trim()).replace(/ +/g, "\\s+");
}

// --- Negation scoping (NegEx-style, deliberately conservative) --------------

const WINDOW_BEFORE = 60; // chars of left context to consider
const WINDOW_AFTER = 45; // chars of right context to consider

// Clause boundaries that end a negation's scope: "no hearing loss, but vision
// problems were noted" must not negate "vision problems".
const SCOPE_BREAK = /[.;:!?]|\b(?:but|however|although|though|except|aside from|whereas|while)\b/i;

// Phrases that LOOK negating but are not — "cannot be ruled out" means the
// finding may well be present. Checked first; a hit suppresses negation.
const PSEUDO_NEGATION =
  /\b(?:no\s+doubt|not\s+only|cannot\s+(?:be\s+)?ruled?\s+out|can'?t\s+(?:be\s+)?ruled?\s+out|could\s+not\s+be\s+ruled\s+out|unable\s+to\s+rule\s+out|not\s+ruled\s+out|difficult\s+to\s+rule\s+out|not\s+possible\s+to\s+exclude)\b/i;

// Cues appearing BEFORE the phrase that negate it.
const PRE_NEGATION =
  /\b(?:no|not|non|never|none|without|denies|denied|denying|negative\s+for|free\s+of|absence\s+of|lack\s+of|lacks|ruled?\s+out|unremarkable\s+for|no\s+longer|resolved|corrected)\b/i;

// Cues appearing AFTER the phrase that negate it.
const POST_NEGATION =
  /\b(?:(?:was|were|is|are|has\s+been|have\s+been)\s+(?:ruled\s+out|excluded|negative|corrected|resolved)|(?:was|were|is|are)\s+not\b|not\s+(?:present|noted|observed|indicated|suspected|evident)|within\s+normal\s+limits|\bwnl\b|ruled\s+out)\b/i;

/** Trim a left-context window to the innermost clause touching the phrase. */
function clipLeft(window: string): string {
  let last = -1;
  const re = new RegExp(SCOPE_BREAK.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) last = m.index + m[0].length;
  return last >= 0 ? window.slice(last) : window;
}

/** Trim a right-context window to the innermost clause touching the phrase. */
function clipRight(window: string): string {
  const m = new RegExp(SCOPE_BREAK.source, "i").exec(window);
  return m ? window.slice(0, m.index) : window;
}

/**
 * Is the match at [index, index+length) negated by its surrounding context?
 * Exported for testing; callers normally read `polarity` off the match.
 */
export function classifyPolarity(text: string, index: number, length: number): Polarity {
  const before = clipLeft(text.slice(Math.max(0, index - WINDOW_BEFORE), index));
  const after = clipRight(text.slice(index + length, index + length + WINDOW_AFTER));

  // "cannot be ruled out" / "not ruled out" → the finding stands.
  if (PSEUDO_NEGATION.test(before) || PSEUDO_NEGATION.test(after)) return "affirmed";
  if (PRE_NEGATION.test(before)) return "negated";
  if (POST_NEGATION.test(after)) return "negated";
  return "affirmed";
}

/**
 * All whole-token, case-insensitive occurrences of `phrase` in `text`, each
 * tagged with its polarity.
 *
 * `text` is expected to be already normalized (see `normalizeForMatching`); the
 * phrase is normalized here so trigger lists can be authored naturally.
 */
export function findPhraseMatches(text: string, phrase: string): PhraseMatch[] {
  const p = normalizeForMatching(phrase).trim();
  if (!p) return [];
  // (?<!\w) / (?!\w): the char adjacent to the phrase must not be a word char,
  // so "ELL" won't match inside "spelling" but will match "ELL" standing alone.
  const re = new RegExp(`(?<!\\w)${phrasePattern(p)}(?!\\w)`, "gi");
  const out: PhraseMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, length: m[0].length, polarity: classifyPolarity(text, m.index, m[0].length) });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return out;
}
