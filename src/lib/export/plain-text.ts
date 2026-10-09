// Markdown to plain text for the exports' reference excerpts (Phase 8): passage
// text read from PDFs and web pages is often Markdown (headings, emphasis,
// tables, links), which a References list would otherwise print raw. Not a
// Markdown parser: a line-by-line pass that keeps the words and drops the
// syntax. Pure and client-safe.

/** Inline syntax: images dropped, links and autolinks to their text, emphasis, code and HTML tags removed. */
function inlinePlain(s: string): string {
  return (
    s
      // Images first (their alt text is not the source's words), then links to their text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/<(https?:[^>\s]+)>/gi, "$1")
      // HTML tags (a <br> reads as a space).
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      // Code spans, then emphasis: **x**, __x__, *x*, _x_, ~~x~~ (an underscore inside a word stays).
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      // Backslash escapes.
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
  );
}

/**
 * Block syntax in the middle of a line. Passages are stored with their line
 * breaks collapsed ("## Results **Table 2.** … | Group | Score | |---|---| | A | 58 |
 * - First point"), so the line-start rules below never see it: inline table
 * rules go, cells are joined by " · ", and heading and list markers after a
 * sentence or a cell are removed.
 */
function flattenedPlain(line: string): string {
  let out = line.replace(/\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?)?/g, " | ");
  if ((out.match(/(?<!\\)\|/g)?.length ?? 0) >= 3) {
    out = out
      .split(/\s*(?<!\\)\|\s*/)
      .filter((c) => c.trim())
      .join(" · ");
  }
  return out
    .replace(/(^|[\s.!?:·])#{1,6}\s+(?=\S)/g, "$1")
    .replace(/(^|[.!?:·])\s*[-*+]\s+(?=\S)/g, "$1 ")
    .replace(/^\s+/, "");
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Pure: `md` as plain text. Headings, blockquote and list markers are removed
 * (the item's words kept), table rows become their cells joined by " · " (the
 * rule row dropped), code fences are removed with their content kept, images
 * are dropped, links read as their text, and HTML tags go. Lines are kept;
 * runs of blank lines collapse to one.
 */
export function markdownToPlain(md: string): string {
  const out: string[] = [];
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(raw) || TABLE_RULE.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    let line = raw
      .replace(/^\s{0,3}(>\s?)+/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/, "");
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim())
        .filter(Boolean)
        .join(" · ");
    }
    line = flattenedPlain(line);
    // Setext heading underlines ("===" / "---" under a line) are syntax only.
    if (/^\s*(=+|-+)\s*$/.test(line) && out.length && out[out.length - 1].trim()) continue;
    out.push(inlinePlain(line).replace(/[ \t]+/g, " ").trim());
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
