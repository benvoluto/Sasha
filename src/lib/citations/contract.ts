// Citations (PLAN §6.8): the `citation` mark's attributes, the [[p:ID]]
// markers drafting models write, what the server reports after checking them,
// and the document's numbered list of sources cited. Client-safe (types and
// pure functions only): the generate and rewrite routes, the editor's mark and
// hover layer, and the exporters all read these.
//
// CONTRACT (Phase 7): see phase7-spec.md §2. Owned by the citations track; the
// rubric and export tracks import it. Change a shape only with every consumer
// updated in the same change.

import type { PMNode } from "@/lib/documents/sections";

// --- The mark ------------------------------------------------------------------

export const CITATION_MARK = "citation";

/** A passage of a source (S<id8>.P<n>), or a data table (an inserted table's source line). */
export const CITATION_KINDS = ["passage", "table"] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

/**
 * The mark's attributes. The mark covers the supported text (a sentence, or a
 * table's source line); the reference number is drawn after it by the editor
 * and the exporters, never stored, because it depends on order of appearance.
 * Several citation marks may cover the same text (the mark has `excludes: ""`).
 */
export type CitationAttrs = {
  kind: CitationKind;
  /** "S1a2b3c4d.P7" for a passage citation; null for a table. */
  passageId: string | null;
  /** The cited source's full id (both kinds). */
  sourceId: string | null;
  /** The data table's id for a table citation; null for a passage. */
  dataTableId: string | null;
  /** The words the model quoted from the passage, when it quoted (checked against the passage). */
  quote: string | null;
  /** True when the server checked the citation (always, for marks it creates); false for marks of unknown origin. */
  verified: boolean;
};

/** HTML attributes the mark is stored under on a <span> (parseHTML / renderHTML; copy and paste keep them). */
export const CITATION_DATA_ATTRS = {
  kind: "data-citation",
  passageId: "data-passage-id",
  sourceId: "data-source-id",
  dataTableId: "data-table-id",
  quote: "data-quote",
  verified: "data-verified",
} as const satisfies Record<keyof CitationAttrs, string>;

export const EMPTY_CITATION: CitationAttrs = { kind: "passage", passageId: null, sourceId: null, dataTableId: null, quote: null, verified: false };

// --- Markers -------------------------------------------------------------------

/** A passage id as pages.ts makes it. */
export const PASSAGE_ID_RE = /^S[0-9a-f]{8}\.P\d{1,6}$/;

/** Longest quote a marker may carry (longer quotes are cut at a word, with an ellipsis, before checking). */
export const MAX_MARKER_QUOTE = 300;

/**
 * A marker: `[[p:S1a2b3c4d.P7]]`, or with the words relied on,
 * `[[p:S1a2b3c4d.P7|exact words from the passage]]`. Deliberately loose, so a
 * malformed marker is still found, reported and removed rather than left in
 * the text: the id is anything up to `|` or `]` (check it with
 * PASSAGE_ID_RE), and the quote may hold single brackets ("12% [3] in 2025")
 * and be any length (parseMarkers cuts it). Neither crosses a line or another
 * `[[`. Global; reset lastIndex or use parseMarkers.
 */
export const MARKER_RE = /\[\[p:([^\]|\n[]*)(?:\|((?:[^\]\n[]|\[(?!\[)|\](?!\]))*))?\]\]/g;

/**
 * What is left of a marker MARKER_RE couldn't read (a `[[` inside the quote,
 * a missing `]]`): `[[p:` up to the next `]]` on its line, or the line's end,
 * with one preceding space. Global and multiline.
 */
export const LEFTOVER_MARKER_RE = /[ \t]?\[\[p:.*?(?:\]\]|$)/gm;

/** A quote cut to MAX_MARKER_QUOTE at a word, marked with an ellipsis (so the check allows its last word to be partial). */
function cutQuote(quote: string): string {
  if (quote.length <= MAX_MARKER_QUOTE) return quote;
  const head = quote.slice(0, MAX_MARKER_QUOTE);
  const space = head.lastIndexOf(" ");
  return `${(space > MAX_MARKER_QUOTE / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

export type ParsedMarker = {
  /** The marker as written. */
  raw: string;
  /** The id as written (trimmed); may be malformed. */
  passageId: string;
  quote: string | null;
  /** Offset of the marker in the text it was parsed from. */
  index: number;
  length: number;
};

/** Pure: every marker in `text`, in order. */
export function parseMarkers(text: string): ParsedMarker[] {
  const out: ParsedMarker[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const quote = m[2]?.trim() ? cutQuote(m[2].trim()) : null;
    out.push({ raw: m[0], passageId: m[1].trim(), quote, index: m.index ?? 0, length: m[0].length });
  }
  return out;
}

/** Why the server dropped a marker. */
export const DROP_REASONS = ["malformed", "unknown_passage", "not_linked", "quote_mismatch"] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type DroppedMarker = { raw: string; passageId: string; reason: DropReason };

/** What the editor needs to build a mark (and the hover) for a kept passage id, without another request. */
export type CitationInfo = {
  passageId: string;
  sourceId: string;
  sourceTitle: string;
  page: number | null;
  /** The first quote the model gave for this passage, when it gave one and it matched. */
  quote: string | null;
  /** The passage text, cut to MAX_CITATION_EXCERPT. */
  excerpt: string;
};

export const MAX_CITATION_EXCERPT = 600;

/** The server's account of the markers in one model reply. */
export type CitationReport = {
  /** Markers kept (each occurrence counts). */
  kept: number;
  dropped: DroppedMarker[];
  /** Every kept passage id. */
  passages: Record<string, CitationInfo>;
};

export const EMPTY_CITATION_REPORT: CitationReport = { kept: 0, dropped: [], passages: {} };

/**
 * A model reply after verification: only valid markers remain, each rewritten
 * to the bare form `[[p:ID]]` (quotes move into `report.passages`), so the
 * Markdown converter never sees quote text.
 */
export type VerifiedMarkdown = { markdown: string; report: CitationReport };

/** What the verifier needs to know about a passage id it is asked about; null when the id is unknown. */
export type ResolvedPassage = {
  passageId: string;
  sourceId: string;
  sourceTitle: string;
  page: number | null;
  text: string;
  /** The source is linked to the document the reply is for (and belongs to the caller's team). */
  linked: boolean;
};

/** Looks a passage id up for one team and document (server; see verify.ts). */
export type PassageResolver = (passageId: string) => Promise<ResolvedPassage | null>;

/** The section menu's "Cite sources": a rewrite that keeps the wording and adds markers. */
export const CITE_SOURCES_INSTRUCTION =
  "Add citations to this section from the linked sources. Keep the wording, order and length exactly as they are; only add a [[p:ID]] marker after each sentence a passage supports. Do not add sentences, and leave unsupported sentences without a marker.";

// --- Sources cited ---------------------------------------------------------------

/** One reference: a passage or a table. `key` is "p:<passageId>" or "t:<dataTableId>". */
export type CitedReference = {
  key: string;
  /** 1-based, in order of first appearance in the document. */
  number: number;
  kind: CitationKind;
  passageId: string | null;
  sourceId: string | null;
  dataTableId: string | null;
  /** The first quote seen for this reference. */
  quote: string | null;
};

export const citationKey = (a: Pick<CitationAttrs, "kind" | "passageId" | "dataTableId">): string | null =>
  a.kind === "table" ? (a.dataTableId ? `t:${a.dataTableId}` : null) : a.passageId ? `p:${a.passageId}` : null;

/** A mark's attrs read loosely from stored JSON (unknown or missing values fall back to EMPTY_CITATION's). */
export function citationAttrs(attrs: Record<string, unknown> | undefined): CitationAttrs {
  const a = attrs ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    kind: a.kind === "table" ? "table" : "passage",
    passageId: str(a.passageId),
    sourceId: str(a.sourceId),
    dataTableId: str(a.dataTableId),
    quote: str(a.quote),
    verified: a.verified === true || a.verified === "true",
  };
}

/**
 * Pure: the document's references, numbered by first appearance (document
 * order, depth first). Adjacent text nodes that carry the same citation count
 * once per occurrence in `occurrences` but share one number.
 */
export function collectCitations(doc: PMNode | null | undefined): { references: CitedReference[]; numberOf: Map<string, number> } {
  const numberOf = new Map<string, number>();
  const references: CitedReference[] = [];
  const walk = (n: PMNode) => {
    for (const m of n.marks ?? []) {
      if (m.type !== CITATION_MARK) continue;
      const a = citationAttrs(m.attrs);
      const key = citationKey(a);
      if (!key || numberOf.has(key)) continue;
      numberOf.set(key, references.length + 1);
      references.push({ key, number: references.length + 1, kind: a.kind, passageId: a.passageId, sourceId: a.sourceId, dataTableId: a.dataTableId, quote: a.quote });
    }
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return { references, numberOf };
}

/** Where a citation opens: the library drawer on the source, focused on the passage or table. */
export function citationHref(a: Pick<CitationAttrs, "kind" | "passageId" | "sourceId" | "dataTableId">): string | null {
  if (!a.sourceId) return null;
  const base = `/library?source=${encodeURIComponent(a.sourceId)}`;
  if (a.kind === "table") return a.dataTableId ? `${base}&table=${encodeURIComponent(a.dataTableId)}` : base;
  return a.passageId ? `${base}&passage=${encodeURIComponent(a.passageId)}` : base;
}

// --- Resolved references and the lint ------------------------------------------------

/**
 * ok: source linked and the passage/table found. unlinked: the source exists but
 * is no longer linked to the document. deleted: the source (or table) is gone.
 * missing: the source exists but the passage id no longer does (re-read text).
 */
export const CITATION_STATUSES = ["ok", "unlinked", "deleted", "missing"] as const;
export type CitationStatus = (typeof CITATION_STATUSES)[number];

export type ResolvedReference = CitedReference & {
  status: CitationStatus;
  /** Source title (or filename / URL); "Deleted source" when gone. */
  sourceTitle: string;
  /** The source's own URL for a URL source; null otherwise. */
  sourceUrl: string | null;
  page: number | null;
  /** The passage text (cut to MAX_CITATION_EXCERPT), or null for a table or a missing passage. */
  excerpt: string | null;
  /** The data table's name for a table citation. */
  tableName: string | null;
};

/** GET /api/documents/[id]/citations: the stored document's references, resolved, with the problems the lint flags. */
export type CitationsResponse = {
  references: ResolvedReference[];
  /** References whose status is not "ok". */
  problems: Array<Pick<ResolvedReference, "key" | "number" | "status" | "sourceTitle">>;
};
