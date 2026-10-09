// Export (PLAN §6.10, decision 8): Markdown, Word and PDF, plus the print HTML
// the PDF is rendered from (and that the browser prints when no server-side
// Chrome is available). Client-safe: the export route and the header's Export
// menu share these.
//
// CONTRACT (Phase 7): see phase7-spec.md §4. Owned by the export track.

import { z } from "zod";
import { CITATION_MARK, citationAttrs, citationKey, collectCitations, type CitedReference, type ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import { markdownToPlain } from "./plain-text";

export const EXPORT_FORMATS = ["md", "docx", "pdf", "html"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * GET /api/documents/[id]/export?format=md|docx|pdf|html
 *
 * Exports the STORED document (the client saves first). Responds with the
 * file (Content-Disposition: attachment, filename from exportFilename), or:
 * - 404 not found, 413 over a size limit, 400 a bad format;
 * - 503 { error, fallback: "print" } for pdf when no browser can be launched:
 *   the client then prints `format=html` itself (window.print on a hidden
 *   same-origin iframe) and says so.
 * `html` is served inline (not as an attachment) with a CSP that forbids
 * scripts and every remote load, for that fallback.
 */
export const ExportQuery = z.strictObject({ format: z.enum(EXPORT_FORMATS) });
export type ExportQuery = z.infer<typeof ExportQuery>;

export type ExportFallback = { error: string; fallback: "print" };

export const EXPORT_MIME: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
};

/** Menu labels; html is not offered in the menu (it is the print fallback). */
export const EXPORT_LABELS: Record<Exclude<ExportFormat, "html">, string> = { md: "Markdown", docx: "Word", pdf: "PDF" };

// --- Limits -----------------------------------------------------------------------

/** Stored content_json larger than this (serialized) is refused with 413. */
export const MAX_EXPORT_JSON_BYTES = 8 * 1024 * 1024;
/** Images inlined into one export, in total (larger documents export with images replaced by their alt text). */
export const MAX_EXPORT_IMAGE_BYTES = 15 * 1024 * 1024;
/** A rendered PDF larger than this is refused. */
export const MAX_EXPORT_PDF_BYTES = 30 * 1024 * 1024;
/** Time allowed for the PDF render (launch + layout + print). */
export const PDF_RENDER_TIMEOUT_MS = 60_000;
/** PDF renders one server instance runs at once (each is a Chrome process of a few hundred MB). */
export const MAX_CONCURRENT_PDF_RENDERS = 2;
/** Renders that may wait for a slot; past that the export is refused with 429 at once. */
export const MAX_QUEUED_PDF_RENDERS = 4;
/** How long a render waits for a slot before it is refused with 429 (counted inside PDF_RENDER_TIMEOUT_MS). */
export const PDF_QUEUE_WAIT_MS = 10_000;

// --- Filenames ----------------------------------------------------------------------

/**
 * A safe download name from the title: letters, digits, spaces, dots,
 * hyphens and underscores kept (Unicode letters too), everything else
 * dropped, runs collapsed, cut to 80 characters, "Untitled document" when
 * nothing is left.
 */
export function exportFilename(title: string, format: Exclude<ExportFormat, "html">): string {
  const base =
    title
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[ .]+|[ .]+$/g, "")
      .slice(0, 80)
      .trim() || "Untitled document";
  return `${base}.${format}`;
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// --- What every writer takes ------------------------------------------------------

/** An image ready to embed: the bytes, a data: URI of them, and the pixel size when the header gave it. */
export type ExportImage = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
  data: Uint8Array;
  dataUri: string;
  width: number | null;
  height: number | null;
};

/** Every image `src` in the document, resolved once (images.ts); null means "write the alt text instead". */
export type ExportImages = Map<string, ExportImage | null>;

/** The route's input to each format writer (markdown.ts, docx.ts, html.ts). */
export type ExportInput = {
  /** The stored document, with legacy table links turned into table citations (exportCitations). */
  doc: PMNode;
  title: string;
  typeTitle: string | null;
  typeKey: string | null;
  /** Resolved references, in number order. */
  references: ResolvedReference[];
  /** citationKey → number (collectCitations). */
  numberOf: Map<string, number>;
  /** The app's origin ("https://sasha.app"): relative links and citation links are made absolute with it. */
  origin: string;
  images: ExportImages;
};

/** The print HTML's policy: no scripts, no remote loads, only data: images and inline styles. */
export const EXPORT_HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

// --- Citations as the exporters see them ----------------------------------------------

/**
 * A table source line written before citation marks existed is a plain link to
 * the table in the library (`/library?source=…&table=…`, tableCitationHref).
 * Parsed here, relative or absolute, so those documents export with numbered
 * table references too.
 */
export function tableLinkCitation(href: unknown): { sourceId: string; dataTableId: string } | null {
  if (typeof href !== "string" || !href.includes("table=")) return null;
  let url: URL;
  try {
    url = new URL(href, "http://local.invalid");
  } catch {
    return null;
  }
  if (url.pathname !== "/library") return null;
  const sourceId = url.searchParams.get("source");
  const dataTableId = url.searchParams.get("table");
  return sourceId && dataTableId ? { sourceId, dataTableId } : null;
}

/**
 * True for a link into the app's library (`/library…`, relative, or absolute on
 * `origin` when given). Exports never carry these (Phase 8): a reader outside
 * the app can't open them.
 */
export function isLibraryHref(href: unknown, origin?: string): boolean {
  if (typeof href !== "string") return false;
  const h = href.replace(/[\u0000- \u007f]/g, "");
  let url: URL;
  try {
    url = new URL(h, "http://local.invalid");
  } catch {
    return false;
  }
  const local = url.origin === "http://local.invalid" && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("//");
  let same = false;
  if (origin) {
    try {
      same = url.origin === new URL(origin).origin;
    } catch {
      same = false;
    }
  }
  return (local || same) && (url.pathname === "/library" || url.pathname.startsWith("/library/"));
}

/**
 * Pure: a copy of `doc` where every legacy table link carries a table citation
 * mark instead, and no link into the library is left (its text stays, as text):
 * a data table's "Source:" line exports as the table title, source and page.
 */
export function withTableLinkCitations(doc: PMNode): PMNode {
  const visit = (n: PMNode): PMNode => {
    let marks = n.marks;
    const link = marks?.find((m) => m.type === "link");
    const table = link ? tableLinkCitation(link.attrs?.href) : null;
    if (marks && table) {
      const has = marks.some((m) => m.type === CITATION_MARK && citationKey(citationAttrs(m.attrs)) === `t:${table.dataTableId}`);
      if (!has) marks = [...marks, { type: CITATION_MARK, attrs: { kind: "table", passageId: null, sourceId: table.sourceId, dataTableId: table.dataTableId, quote: null, verified: false } }];
    }
    if (marks && link && isLibraryHref(link.attrs?.href)) marks = marks.filter((m) => m !== link);
    return { ...n, ...(marks ? { marks } : {}), ...(n.content ? { content: n.content.map(visit) } : {}) };
  };
  return visit(doc);
}

/** Pure: the document as exported (legacy table links included) and its references, numbered by first appearance. */
export function exportCitations(doc: PMNode | null | undefined): { doc: PMNode; references: CitedReference[]; numberOf: Map<string, number> } {
  const normalized = withTableLinkCitations(doc ?? { type: "doc", content: [] });
  return { doc: normalized, ...collectCitations(normalized) };
}

/** The reference numbers on one node's marks, ascending and unique. */
export function citationNumbers(n: PMNode, numberOf: Map<string, number>): number[] {
  const out = new Set<number>();
  for (const m of n.marks ?? []) {
    if (m.type !== CITATION_MARK) continue;
    const key = citationKey(citationAttrs(m.attrs));
    const num = key ? numberOf.get(key) : undefined;
    if (num) out.add(num);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * For each inline child of a textblock, the reference numbers whose run ends
 * there (the next child doesn't carry them), ascending: where the exporters put
 * "[n]", a footnote, or a superscript. Each entry is one citation occurrence.
 */
export function citationEnds(inlines: PMNode[], numberOf: Map<string, number>): number[][] {
  const sets = inlines.map((n) => citationNumbers(n, numberOf));
  return sets.map((nums, i) => nums.filter((k) => !(sets[i + 1] ?? []).includes(k)));
}

/** Citation occurrences in the whole document (one per run end per number). */
export function countCitationOccurrences(doc: PMNode, numberOf: Map<string, number>): number {
  let count = 0;
  const walk = (n: PMNode) => {
    const kids = n.content ?? [];
    if (kids.some((c) => c.type === "text")) for (const e of citationEnds(kids, numberOf)) count += e.length;
    else kids.forEach(walk);
  };
  walk(doc);
  return count;
}

/** Any run of whitespace (newlines included) as one space, trimmed. */
export const flatten = (s: string) => s.replace(/\s+/g, " ").trim();

const cut = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/**
 * A reference as the exports and the rubric check see it: resolveReferences
 * also gives an uploaded file's name (absent on references built elsewhere).
 */
export type ExportReference = ResolvedReference & { fileName?: string | null };

/** A URL source's own address, when it is a plain http(s) URL; never a link into the app. */
export function sourceAddress(r: Pick<ResolvedReference, "sourceUrl">): string | null {
  const u = r.sourceUrl?.trim();
  if (!u || !/^https?:\/\//i.test(u)) return null;
  try {
    return new URL(u).href;
  } catch {
    return null;
  }
}

/**
 * "Q3 Industry Report (q3.pdf), p. 4" for an uploaded file, "Rates explained,
 * https://example.org/rates" for a URL source, and for a table "Table “Prices
 * 2025”, Pricing (prices.xlsx)". Never an in-app link.
 */
export function referenceLabel(r: ExportReference): string {
  const page = r.page !== null && r.page !== undefined ? `, p. ${r.page}` : "";
  // Titles come from source records and may hold newlines: one line always,
  // so no exporter can have a title end a list item or a link definition.
  const title = flatten(r.sourceTitle);
  const file = flatten(r.fileName ?? "");
  const named = file && file !== title ? `${title} (${file})` : title;
  const address = sourceAddress(r);
  const at = address && address !== title && r.sourceUrl?.trim() !== title ? `, ${address}` : "";
  if (r.kind === "table") return `Table “${flatten(r.tableName ?? "") || "Table"}”, ${named}${page}`;
  return `${named}${page}${at}`;
}

/** The excerpt printed with a passage reference: the quote relied on, else the passage, as plain text cut to `max`. */
export function referenceExcerpt(r: ResolvedReference, max = 200): string | null {
  if (r.kind === "table") return null;
  const text = r.quote ?? r.excerpt;
  const plain = text ? markdownToPlain(text) : "";
  return plain.trim() ? `“${cut(plain, max)}”` : null;
}

/** One reference as a line of text: label, then the excerpt. */
export function referenceLine(r: ExportReference, max = 200): string {
  const excerpt = referenceExcerpt(r, max);
  return excerpt ? `${referenceLabel(r)}. ${excerpt}` : referenceLabel(r);
}

const STALE_REASON: Record<Exclude<ResolvedReference["status"], "ok">, string> = {
  unlinked: "the source was unlinked from this document",
  deleted: "the source was deleted",
  missing: "the source was re-read and the passage no longer exists",
};

/** A note on references that no longer hold, or null when all do. */
export function staleNote(refs: ResolvedReference[]): string | null {
  const stale = refs.filter((r) => r.status !== "ok");
  if (!stale.length) return null;
  return `Some references may be out of date: ${stale.map((r) => `${r.number}, ${STALE_REASON[r.status as Exclude<typeof r.status, "ok">]}`).join("; ")}.`;
}

/**
 * A link target the exporters may write: http(s) and mailto as they are,
 * relative links (path, query or fragment) made absolute with `origin`, and
 * null for anything else (javascript:, data:, vbscript:, protocol-relative…).
 */
export function safeHref(href: unknown, origin: string): string | null {
  if (typeof href !== "string") return null;
  // Links into the app's library are never exported (Phase 8).
  if (isLibraryHref(href, origin)) return null;
  // Browsers ignore control characters and spaces inside a scheme ("java\tscript:").
  const h = href.replace(/[\u0000- \u007f]/g, "");
  if (!h) return null;
  if (/^(https?:|mailto:)/i.test(h)) {
    try {
      return new URL(h).href;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("\\")) return null;
  try {
    const url = new URL(h, origin);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Where a reference points: a URL source's own address, else nothing. Never
 * the in-app library (Phase 8): an uploaded file is cited by its title, file
 * name and page instead.
 */
export function referenceHref(r: ResolvedReference, origin: string): string | null {
  const address = sourceAddress(r);
  return address ? safeHref(address, origin) : null;
}
