// Personal details in a learned draft (PLAN §6.11 Privacy: "extracted types
// keep no personal details"). Examples may be FIEs or resumes; the type and
// workflow made from them must describe the pattern, never the person.
//
// Found two ways, both only in the draft (the examples stay as they are, team
// sources):
// - by pattern: emails, phone numbers, dates of birth, ID-like numbers and
//   street addresses;
// - by origin: proper-noun spans (two or more capitalized words, used
//   mid-sentence in an example or in its title heading, not a section heading,
//   a published test or instrument, or catalog vocabulary), the first and last
//   names of those spans when the example also uses them alone ("Jordan's
//   scores"), not made only of role, office and fund words ("City Manager",
//   "General Fund"), that appear in an example and again in the draft, plus any the
//   model pointed out. All-caps names ("# JORDAN ALVAREZ", "STUDENT: JORDAN
//   ALVAREZ", "at ACME CORP") count too, matched in the draft in any case.
// Keys are not prose, so they are not walked; `personalInKey` checks a key
// built from a title (the type key) for the same names instead.
// Each is replaced by a neutral placeholder ([Name], [Organization], …) and
// flagged `removed: true`. The save route runs the same check on what the
// author sends, with the model's hints again, and refuses while anything is
// found that the author has not kept (names and organizations only: a test
// name can be a false positive; a pattern never is).
//
// Pure and client-safe.

import { fileTypes } from "@/catalog/files";
import { slugify } from "@/catalog/from-outline";
import { KEEPABLE_PERSONAL_KINDS, type PersonalDetailFlag, type PersonalDetailKind } from "./contract";
import { mapDraftStrings, type DraftParts } from "./overlap";

export const PLACEHOLDERS: Record<PersonalDetailKind, string> = {
  name: "[Name]",
  email: "[Email]",
  phone: "[Phone]",
  address: "[Address]",
  date_of_birth: "[Date of birth]",
  id_number: "[ID number]",
  organization: "[Organization]",
  other: "[Detail]",
};

/** Patterns, most specific first (an SSN-like number is an ID, not a phone number). */
const PATTERNS: Array<{ kind: PersonalDetailKind; re: RegExp }> = [
  { kind: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { kind: "date_of_birth", re: /\b(?:DOB|D\.O\.B\.|date of birth|birth ?date|born(?: on)?)\s*[:-]?\s*(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2,8} \d{4})/gi },
  { kind: "id_number", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "id_number", re: /\b(?:ID|MRN|SSN|Student ID|Employee ID|Case|Account|Medicaid|Medicare)\s*(?:No\.?|number|#)?\s*[:#]?\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}\b/g },
  { kind: "phone", re: /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g },
  { kind: "id_number", re: /\b\d{7,}\b/g },
  {
    kind: "address",
    re: /\b\d{1,6}\s+(?:[A-Z][a-z]+\.?\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Parkway|Pkwy|Highway|Hwy|Circle|Cir)\b/g,
  },
];

/** Words that make a proper-noun span an organization rather than a person. */
const ORG_WORDS = /\b(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|University|College|School|District|ISD|Academy|Hospital|Clinic|Institute|Foundation|Center|Centre|Laboratory|Lab|Group|Partners|Associates|Council|Church|Society|Trust|Bank)\b\.?/;
/** Public bodies and laws: named in guidance on purpose, never personal. */
const PUBLIC_WORDS = /\b(?:National|Federal|Department|Agency|Administration|Institutes?|Office|Bureau|Congress|Act|Code|Regulations?|Commission|Service|Government|State|United States|U\.S\.)\b/;
/** Published tests and rating instruments (Wechsler Intelligence Scale for Children, Behavior Assessment System for Children): named in guidance on purpose. */
const INSTRUMENT_WORDS = /\b(?:Scales?|Tests?|Inventory|Inventories|Battery|Ratings?|Assessments?|System|Checklist|Questionnaire|Profile|Survey|Index|Measures?|Screener)\b/;
/** Words that make a title heading's span the document's kind ("Evaluation Report", "Design Document"), not a name. */
const DOC_WORDS = new Set(
  "report evaluation reevaluation document plan proposal design review letter resume résumé curriculum vitae cv memo memorandum brief statement program project application request form analysis individualized individual education initial annual progress narrative cover functional behavior behavioral intervention psychological educational".split(" "),
);
const CONNECTORS = new Set(["of", "for", "and", "de", "van", "von", "the"]);
/**
 * Offices, roles and public funds that every organization of a kind has ("City
 * Manager", "General Fund", "City Council", "Board of Directors"): a span made
 * only of these (with document and common words) names a role, not someone.
 */
const GENERIC_WORDS = new Set(
  "city county town village borough municipal municipality council board commission committee authority manager administrator director deputy assistant mayor clerk attorney treasurer auditor controller chair chairperson chief officer staff general fund funds capital operating reserve finance financial works public parks recreation planning budget superintendent principal president vice executive legal human resources directors trustees members member department office team unit division services agency engineer analyst coordinator specialist planner accountant technician inspector supervisor counsel".split(" "),
);
/** Capitalized words that start sentences or headings often enough to say nothing. */
const COMMON = new Set(
  "the a an this that these those it its our we you your their they he she his her i in on at by for to of and or but if when while with from as is are was were be been not no yes all any each every some most more less many first second third next last new final draft section summary overview introduction background methods results discussion conclusion conclusions appendix table figure page part chapter step goal goals aim aims objective objectives plan scope purpose approach budget timeline references notes date name title signature dear sincerely regards monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);

let vocab: string | null = null;
/** Every catalog type's text, lowercased: a span found here is the domain's vocabulary, not a name. */
export function catalogVocabulary(): string {
  vocab ??= JSON.stringify(fileTypes()).toLowerCase();
  return vocab;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SPAN_RE = /\b[A-Z][a-z’'-]+(?:\s+(?:[A-Z]\.|[A-Z][a-z’'-]+|of|for|and|de|van|von|the)){1,4}/g;
/** All-caps runs of two to five words ("JORDAN Q. ALVAREZ", "ACME CORP"): resume and form headers. */
const CAPS_RE = /\b[A-Z][A-Z’'-]+(?:[ \t]+(?:[A-Z]\.|[A-Z][A-Z’'-]+)){1,4}\b\.?/g;
/** Header lines whose value names a person or organization ("Student: JORDAN ALVAREZ"). */
const LABEL_LINE_RE =
  /^[ \t>*_-]*(?:name|full name|student(?: name)?|child(?:['’]s name)?|candidate|applicant|employee|client|patient|parents?|guardian|prepared (?:for|by)|examiner|evaluator|teacher|case manager|school|campus|district|employer|company|organization|contact)[*_]*[ \t]*:[ \t]*(.+)$/gim;

const isCommon = (w: string) => COMMON.has(w.toLowerCase().replace(/[’'.]/g, "")) || CONNECTORS.has(w);
/** Only role, office, fund, document and common words: "City Manager", "City Council Staff Report", "the General Fund". */
export const isGenericSpan = (text: string) =>
  text
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[’']s$/, "").replace(/[’'.]/g, ""))
    .every((w) => GENERIC_WORDS.has(w) || DOC_WORDS.has(w) || COMMON.has(w) || CONNECTORS.has(w));
/** A word of the catalog's vocabulary (word-bounded, so "Lee" isn't found in "sleep"). */
const inVocabulary = (vocabulary: string, word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word.toLowerCase())}(?![\\p{L}\\p{N}])`, "u").test(vocabulary);
const wordRe = (text: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(text)}(?![\\p{L}\\p{N}])`, "gu");
const occurrences = (haystack: string, text: string) => haystack.match(wordRe(text))?.length ?? 0;

const titleCase = (w: string) => w.charAt(0) + w.slice(1).toLowerCase();

/** A span's words with trailing connectors dropped ("Jordan Alvarez of" → "Jordan Alvarez"). */
function trimSpan(raw: string): string[] {
  const words = raw.split(/\s+/);
  while (words.length && CONNECTORS.has(words.at(-1)!)) words.pop();
  return words;
}

/** Runs of two or more capitalized words split at connectors ("Evaluation Report for Jordan Alvarez" → both halves). */
function titleSpans(title: string, re = SPAN_RE): string[] {
  const out: string[] = [];
  for (const m of title.matchAll(re)) {
    let run: string[] = [];
    for (const w of [...m[0].replace(/\.$/, "").split(/\s+/), "of"]) {
      if (CONNECTORS.has(w.toLowerCase())) {
        if (run.length >= 2) out.push(run.join(" "));
        run = [];
      } else run.push(w);
    }
  }
  return out;
}

/**
 * Proper-noun spans in an example that could identify someone: two to five
 * capitalized words (connectors allowed inside, not at the end), used at least
 * once mid-sentence (after a lowercase word, a comma or a digit, so section
 * headings and sentence openings alone don't count) or in the title heading
 * (the first level-1 heading: "# Evaluation Report for Jordan Alvarez", "# Jane Doe"),
 * not made only of common words, not a section heading, not a published test
 * or instrument, not a public body, and not in the catalog's vocabulary. Then
 * the first and last names of each person's name, when the example also uses
 * them alone.
 */
export type NounSpan = { text: string; kind: PersonalDetailKind; caseless?: true };

export function properNounSpans(example: string, headings: string[] = [], vocabulary = catalogVocabulary()): NounSpan[] {
  // The title (the example's first level-1 heading) names the person as often as not; only the other headings are section vocabulary.
  const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(example)?.[1].replace(/\*\*|__/g, "").trim() ?? "";
  const title = headings.find((h) => h.trim() === h1) ?? "";
  const sections = new Set(headings.filter((h) => h !== title).map((h) => h.trim().toLowerCase()));
  const out = new Map<string, PersonalDetailKind>();
  // A test's author names stay with the test ("Woodcock Johnson" of "Woodcock Johnson Tests of Achievement").
  const instruments = new Set<string>();
  for (const m of example.matchAll(SPAN_RE)) {
    const words = trimSpan(m[0]);
    const at = words.findIndex((w) => INSTRUMENT_WORDS.test(w));
    if (at >= 2) instruments.add(words.slice(0, at).join(" ").toLowerCase());
  }
  const consider = (words: string[], docWords: boolean) => {
    if (words.length < 2) return;
    const text = words.join(" ");
    const lower = text.toLowerCase();
    if (out.has(text) || sections.has(lower) || instruments.has(lower)) return;
    if (words.every((w) => isCommon(w) || (docWords && DOC_WORDS.has(w.toLowerCase())))) return;
    if (isGenericSpan(text)) return;
    if (INSTRUMENT_WORDS.test(text) || vocabulary.includes(lower)) return;
    const isOrg = ORG_WORDS.test(text);
    if (!isOrg && PUBLIC_WORDS.test(text)) return;
    out.set(text, isOrg ? "organization" : "name");
  };
  for (const m of example.matchAll(SPAN_RE)) {
    // Emphasis marks don't end a sentence: "**Prepared by:** Dana Whitfield" is mid-line.
    const before = example.slice(Math.max(0, m.index! - 8), m.index!).replace(/[*_]+/g, "");
    if (/[a-z0-9,;:(]\s*$/.test(before)) consider(trimSpan(m[0]), false);
  }
  if (title) for (const span of titleSpans(title)) consider(span.split(" "), true);
  // All-caps spans, from the title heading and header lines (and mid-sentence
  // only when they read as an organization: "at ACME CORP"), are tested in title
  // case and need two words that are not common, document or vocabulary words
  // ("IEP PROGRESS REPORT" and "WORK EXPERIENCE" are not names).
  const caps = new Set<string>();
  const considerCaps = (span: string, orgOnly: boolean) => {
    const words = span.split(/\s+/);
    const proper = words.map(titleCase).join(" ");
    const lower = span.toLowerCase();
    const telling = words.filter((w) => !/^[A-Z]\.$/.test(w) && !isCommon(w) && !DOC_WORDS.has(w.toLowerCase()) && !inVocabulary(vocabulary, w));
    if (words.length < 2 || telling.length < 2 || out.has(span) || sections.has(lower) || instruments.has(lower) || vocabulary.includes(lower) || isGenericSpan(span)) return;
    if (INSTRUMENT_WORDS.test(proper)) return;
    const isOrg = ORG_WORDS.test(proper) || ORG_WORDS.test(span); // "ACME CORP" as "Acme Corp"; "RIVERBEND ISD" as is
    if ((!isOrg && PUBLIC_WORDS.test(proper)) || (orgOnly && !isOrg)) return;
    out.set(span, isOrg ? "organization" : "name");
    caps.add(span);
  };
  if (title) for (const span of titleSpans(title, CAPS_RE)) considerCaps(span, false);
  for (const m of example.matchAll(LABEL_LINE_RE)) for (const span of titleSpans(m[1], CAPS_RE)) considerCaps(span, false);
  for (const m of example.matchAll(CAPS_RE)) {
    const before = example.slice(Math.max(0, m.index! - 3), m.index!);
    if (/[a-z0-9,;(]\s*$/.test(before)) for (const span of titleSpans(m[0], CAPS_RE)) considerCaps(span, true);
  }
  // "Jordan's scores…" after "Jordan Alvarez" (or "JORDAN ALVAREZ"): a person's first or last name used alone.
  for (const [text, kind] of [...out]) {
    if (kind !== "name") continue;
    const words = text
      .split(" ")
      .filter((w) => !CONNECTORS.has(w) && !/^[A-Z]\.$/.test(w))
      .map((w) => (caps.has(text) ? titleCase(w) : w));
    for (const w of new Set([words[0], words.at(-1)!])) {
      if (w.length < 3 || out.has(w) || isCommon(w) || inVocabulary(vocabulary, w)) continue;
      const spans = [...out.keys()].filter((t) => t !== w && wordRe(w).test(t));
      const alone = occurrences(example, w) - spans.reduce((n, t) => n + occurrences(example, t), 0);
      if (alone > 0) out.set(w, "name");
    }
  }
  return [...out].map(([text, kind]) => (caps.has(text) ? { text, kind, caseless: true as const } : { text, kind }));
}

export type ExampleText = { text: string; headings?: string[] };
export type PersonalHint = { text: string; kind: PersonalDetailKind };

type Finding = { kind: PersonalDetailKind; re: RegExp };

/** The names and organizations found in the examples, with the model's hints (each must come from an example, in any case). */
function namedSpans(examples: ExampleText[], hints: PersonalHint[], vocabulary?: string): NounSpan[] {
  const spans = new Map<string, NounSpan>();
  for (const e of examples) for (const s of properNounSpans(e.text, e.headings, vocabulary)) spans.set(s.text, s);
  for (const h of hints) {
    const t = h.text.trim();
    // A role or fund the model pointed out ("City Manager") is the kind's vocabulary, not a person.
    if (t.length < 3 || spans.has(t) || ((h.kind === "name" || h.kind === "organization") && isGenericSpan(t))) continue;
    // A hint must be specific enough to replace safely, and come from an example; one the example writes in another case ("JORDAN ALVAREZ") matches in any case.
    if (examples.some((e) => e.text.includes(t))) spans.set(t, { text: t, kind: h.kind });
    else if (examples.some((e) => e.text.toLowerCase().includes(t.toLowerCase()))) spans.set(t, { text: t, kind: h.kind, caseless: true });
  }
  return [...spans.values()];
}

/** What to look for in the draft: the patterns, then the examples' spans and the model's hints (longest first, so "Jane Q. Doe" goes before "Jane Q"). */
function findings(examples: ExampleText[], hints: PersonalHint[], vocabulary?: string): Finding[] {
  const named = namedSpans(examples, hints, vocabulary)
    .sort((a, b) => b.text.length - a.text.length)
    .map(({ text, kind, caseless }) => ({ kind, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(text)}(?![\\p{L}\\p{N}])`, caseless ? "giu" : "gu") }));
  return [...PATTERNS, ...named];
}

/**
 * The names and organizations a key spells out ("evaluation-report-for-jordan-alvarez"
 * holds "Jordan Alvarez"): keys are not walked as prose, so a type key built
 * from a title is checked here, at extraction and at save.
 */
export function personalInKey(key: string, examples: ExampleText[], hints: PersonalHint[] = [], vocabulary?: string): string[] {
  const padded = `-${key}-`;
  return namedSpans(examples, hints, vocabulary)
    .filter((s) => s.kind === "name" || s.kind === "organization")
    .filter((s) => {
      const slug = slugify(s.text, 80);
      return slug.length >= 3 && padded.includes(`-${slug}-`);
    })
    .map((s) => s.text);
}

/** One string with its personal details replaced (a title, before a key is built from it). */
export function scrubText(value: string, examples: ExampleText[], hints: PersonalHint[] = [], vocabulary?: string): string {
  let next = value;
  for (const f of findings(examples, hints, vocabulary)) next = next.replace(f.re, PLACEHOLDERS[f.kind]);
  return next;
}

/**
 * Replace every personal detail in the draft with its placeholder. Returns the
 * scrubbed draft and one flag per (path, text), `removed: true`.
 */
export function scrubPersonalDetails<T extends Partial<DraftParts>>(draft: T, examples: ExampleText[], hints: PersonalHint[] = [], vocabulary?: string): { draft: T; flags: PersonalDetailFlag[] } {
  const all = findings(examples, hints, vocabulary);
  const flags: PersonalDetailFlag[] = [];
  const seen = new Set<string>();
  const scrubbed = mapDraftStrings(draft, (path, value) => {
    let next = value;
    for (const f of all) {
      next = next.replace(f.re, (match) => {
        const id = `${path}\u0000${match}`;
        if (!seen.has(id)) {
          seen.add(id);
          flags.push({ path, text: match, kind: f.kind, removed: true });
        }
        return PLACEHOLDERS[f.kind];
      });
    }
    return next;
  });
  return { draft: scrubbed, flags };
}

/**
 * The personal details still in a draft (the save route's check): the same
 * search, with the extraction's hints again (each still has to appear in an
 * example), nothing replaced, flags `removed: false`.
 */
export function findPersonalDetails(draft: Partial<DraftParts>, examples: ExampleText[], hints: PersonalHint[] = [], vocabulary?: string): PersonalDetailFlag[] {
  return scrubPersonalDetails(draft, examples, hints, vocabulary).flags.map((f) => ({ ...f, removed: false }));
}

/** The flags the author has not kept: a kept text clears its name and organization flags only. */
export function unkeptPersonalDetails(flags: PersonalDetailFlag[], keep: string[]): PersonalDetailFlag[] {
  const kept = new Set(keep.map((k) => k.trim()));
  return flags.filter((f) => !(KEEPABLE_PERSONAL_KINDS.has(f.kind) && kept.has(f.text.trim())));
}
