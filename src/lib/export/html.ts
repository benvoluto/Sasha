// Print HTML (phase7-spec.md §4.4): the stored document as one self-contained
// page, rendered to PDF by pdf.ts and printed by the browser when no server
// Chrome is available. Title and type line, the body (tiptapToHtml, which
// escapes everything and allows only safe links and data: images), then the
// References as endnotes whose numbers match the superscripts.
//
// The page loads nothing: the CSP (mirrored in a meta tag) allows no scripts,
// no remote fonts or images, and the CSS is inline. Pure.

import { citationAttrs, citationKey } from "@/lib/citations/contract";
import { escapeHtml, tiptapToHtml } from "@/lib/report/markdown-to-tiptap";
import { EXPORT_HTML_CSP, referenceExcerpt, referenceHref, referenceLabel, staleNote, type ExportInput } from "./contract";
import { PRINT_CSS } from "./print-css";

// frame-ancestors is ignored (and warned about) in a meta policy; the header carries it.
const META_CSP = EXPORT_HTML_CSP.replace(/;\s*frame-ancestors[^;]*/, "");

export type PrintHtmlOptions = {
  /**
   * Keep SVG images. Off by default: the PDF and the print fallback write the
   * alt text instead (phase7-spec.md §4.1; nothing rasterizes them yet).
   */
  allowSvg?: boolean;
};

function endnotes(input: ExportInput): string {
  if (!input.references.length) return "";
  const items = input.references
    .map((r) => {
      const href = referenceHref(r, input.origin);
      const label = escapeHtml(referenceLabel(r));
      const excerpt = referenceExcerpt(r);
      const stale = r.status !== "ok" ? ' class="stale-ref"' : "";
      return `<li id="ref-${r.number}"${stale}>${href ? `<a href="${escapeHtml(href)}">${label}</a>` : label}${excerpt ? `. ${escapeHtml(excerpt)}` : ""}</li>`;
    })
    .join("");
  const note = staleNote(input.references);
  return `<section class="endnotes"><h2>References</h2><ol>${items}</ol>${note ? `<p class="stale">${escapeHtml(note)}</p>` : ""}</section>`;
}

/** The full print document. */
export function printHtml(input: ExportInput, opts: PrintHtmlOptions = {}): string {
  const body = tiptapToHtml(input.doc, {
    origin: input.origin,
    citationNumber: (attrs) => {
      const key = citationKey(citationAttrs(attrs));
      return key ? (input.numberOf.get(key) ?? null) : null;
    },
    imageSrc: (src) => {
      const image = input.images.get(src);
      if (!image || (image.mime === "image/svg+xml" && !opts.allowSvg)) return null;
      return image.dataUri;
    },
  });
  const title = input.title.trim() || "Untitled document";
  const typeLine = input.typeTitle?.trim() ? `<p class="doc-type">${escapeHtml(input.typeTitle.trim())}</p>` : "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(META_CSP)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PRINT_CSS}</style>`,
    "</head>",
    "<body>",
    `<header class="doc-title"><h1>${escapeHtml(title)}</h1>${typeLine}</header>`,
    `<main>${body}</main>`,
    endnotes(input),
    "</body>",
    "</html>",
    "",
  ]
    .filter((l, i, a) => l !== "" || i === a.length - 1)
    .join("\n");
}
