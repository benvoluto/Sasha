// Pure helpers for the Export menu (export-menu.tsx): the request URL, the
// download name from the response, what to say when an export fails, and
// whether the server asked the browser to print instead.

import { EXPORT_LABELS, exportFilename, type ExportFormat } from "@/lib/export/contract";

export type MenuFormat = Exclude<ExportFormat, "html">;

export const MENU_FORMATS: MenuFormat[] = ["md", "docx", "pdf"];

export const MENU_ITEM_LABEL: Record<MenuFormat, string> = { md: `${EXPORT_LABELS.md} (.md)`, docx: `${EXPORT_LABELS.docx} (.docx)`, pdf: `${EXPORT_LABELS.pdf} (.pdf)` };

export const PRINT_FALLBACK_NOTICE = "PDF rendering isn't available here, so your browser's print dialog will open. Choose 'Save as PDF'.";

/** How long the print iframe may stay when the browser never fires afterprint. */
export const PRINT_CLEANUP_MS = 60_000;

export const exportUrl = (documentId: string, format: ExportFormat) => `/api/documents/${encodeURIComponent(documentId)}/export?format=${format}`;

/**
 * The filename from a Content-Disposition header: the RFC 5987 `filename*`
 * first, then `filename`, else the name made from the title. Path separators
 * and control characters are removed either way.
 */
export function filenameFromDisposition(header: string | null, title: string, format: MenuFormat): string {
  const fallback = exportFilename(title, format);
  if (!header) return fallback;
  let name: string | null = null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    name = plain ? (plain[1] ?? plain[2] ?? "").replace(/\\(.)/g, "$1").trim() : null;
  }
  const clean = (name ?? "").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/^[\s.]+/, "").trim();
  return clean || fallback;
}

/** The server's error body, read loosely. */
export type ExportErrorBody = { error?: unknown; fallback?: unknown } | null;

/** True when a failed PDF export asks the client to print the HTML instead. */
export const isPrintFallback = (status: number, body: ExportErrorBody) => status === 503 && body?.fallback === "print";

/** What the notice says when an export fails. */
export function exportErrorMessage(status: number, format: MenuFormat, body: ExportErrorBody): string {
  const label = EXPORT_LABELS[format];
  if (status === 413) return `This document is too large to export as ${label}.`;
  if (status === 404) return "This document wasn't found. It may have been deleted.";
  if (status === 401) return "Sign in again to export.";
  if (status === 403) return "You don't have permission to export this document.";
  if (status === 504) return `The ${label} export took too long. Try again.`;
  const server = typeof body?.error === "string" && body.error.length <= 200 ? body.error : null;
  // A rate limit or a full render queue: the server's sentence says when to try again.
  if (status === 429) return server ?? `Too many ${label} exports right now. Try again in a moment.`;
  return server ?? `The ${label} export failed. Try again.`;
}
