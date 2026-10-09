// Pure-JS markdown → ProseMirror/Tiptap JSON converter for the report editor.
// Targets the StarterKit node/mark names the editor uses (heading, paragraph,
// bulletList/orderedList/listItem, bold, italic, horizontalRule), so generated
// content loads into Tiptap without any node being silently dropped. No DOM and
// no Tiptap import needed — it emits plain ProseMirror JSON.
//
// Scope: the subset the model is asked to produce (headings, paragraphs, lists,
// bold/italic, rules, and GFM pipe tables). Figure-heavy content renders as tables.

export type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };
export type PMDoc = { type: "doc"; content: PMNode[] };

export function emptyDoc(): PMDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

// Backslash escapes (CommonMark: any ASCII punctuation) hide the character from
// the inline patterns below and are restored as plain text, so `\*` stays a
// literal asterisk. They are swapped for private-use characters while parsing.
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const PRIVATE_BASE = 0xe000;
const hideEscapes = (text: string) => text.replace(ESCAPED, (_, c: string) => String.fromCharCode(PRIVATE_BASE + c.charCodeAt(0)));
const restoreEscapes = (text: string) => text.replace(/[\ue021-\ue07e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - PRIVATE_BASE));

// Inline **bold**, *italic* / _italic_ → text nodes with marks. Minimal but safe.
function inline(raw: string): PMNode[] {
  const text = hideEscapes(raw);
  const nodes: PMNode[] = [];
  const push = (t: string, marks?: PMNode["marks"]) => nodes.push(marks ? { type: "text", text: restoreEscapes(t), marks } : { type: "text", text: restoreEscapes(t) });
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[2] !== undefined) push(m[2], [{ type: "bold" }]);
    else if (m[4] !== undefined) push(m[4], [{ type: "italic" }]);
    else if (m[6] !== undefined) push(m[6], [{ type: "italic" }]);
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return nodes.length ? nodes : [{ type: "text", text: restoreEscapes(text) }];
}

function listItem(text: string): PMNode {
  return { type: "listItem", content: [{ type: "paragraph", content: inline(text) }] };
}

// --- GFM pipe tables ---------------------------------------------------------

// A GFM separator row: |---|---| . The trailing group is optional so a
// single-column table (`| --- |`) is recognized too; requiring a pipe keeps a
// bare `---` reading as a horizontal rule rather than a one-column table.
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isTableSep = (line: string | undefined) => !!line && line.includes("|") && TABLE_SEP.test(line);

/** Split a pipe-table row into cell strings (handles optional leading/trailing pipes and \| escapes). */
function tableCells(line: string): string[] {
  const cells = line.replace(/\\\|/g, "\0").split("|").map((c) => c.replace(/\0/g, "|").trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function cellNode(type: "tableHeader" | "tableCell", text: string): PMNode {
  return { type, content: [{ type: "paragraph", content: text ? inline(text) : [] }] };
}

function tableRow(type: "tableHeader" | "tableCell", cells: string[], width: number): PMNode {
  const content: PMNode[] = [];
  for (let c = 0; c < width; c++) content.push(cellNode(type, cells[c] ?? ""));
  return { type: "tableRow", content };
}

export type MarkdownOptions = {
  /**
   * Keep single line breaks inside a paragraph as hardBreak nodes instead of
   * joining the lines with a space (Markdown's soft break). For line-per-field
   * text such as a memo header ("**To:** …\n**From:** …").
   */
  lineBreaks?: boolean;
};

function paragraphContent(lines: string[], lineBreaks: boolean): PMNode[] {
  if (!lineBreaks) return inline(lines.join(" "));
  return lines.flatMap((l, i) => (i ? [{ type: "hardBreak" }, ...inline(l)] : inline(l)));
}

export function markdownToTiptap(markdown: string, opts: MarkdownOptions = {}): PMDoc {
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
  const content: PMNode[] = [];
  let i = 0;

  const flushList = (ordered: boolean, items: PMNode[]) => {
    if (items.length) content.push({ type: ordered ? "orderedList" : "bulletList", content: items });
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") { i++; continue; }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) { content.push({ type: "horizontalRule" }); i++; continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) { content.push({ type: "heading", attrs: { level: h[1].length }, content: inline(h[2]) }); i++; continue; }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { items.push(listItem(lines[i].trim().replace(/^[-*+]\s+/, ""))); i++; }
      flushList(false, items);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) { items.push(listItem(lines[i].trim().replace(/^\d+[.)]\s+/, ""))); i++; }
      flushList(true, items);
      continue;
    }

    // GFM pipe table: a header row with '|' followed by a --- separator row.
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = tableCells(trimmed);
      const width = header.length;
      const rows: PMNode[] = [tableRow("tableHeader", header, width)];
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim() !== "") {
        rows.push(tableRow("tableCell", tableCells(lines[i].trim()), width));
        i++;
      }
      content.push({ type: "table", content: rows });
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-structural lines.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (l === "" || /^(#{1,6})\s+/.test(l) || /^[-*+]\s+/.test(l) || /^\d+[.)]\s+/.test(l) || /^---+$/.test(l)) break;
      if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break; // start of a table
      para.push(l);
      i++;
    }
    content.push({ type: "paragraph", content: paragraphContent(para, !!opts.lineBreaks) });
  }

  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

// --- ProseMirror JSON → HTML -------------------------------------------------
// Lets a section be displayed (and exported) WITHOUT mounting a Tiptap editor.
// Covers exactly the node/mark set the editor uses; unknown nodes render their
// children so nothing silently disappears.
//
// Stored content is untrusted: every text and attribute is escaped, links pass
// only for http(s), mailto, fragments and same-site paths, images only for
// data: images, https and same-site paths (or what `imageSrc` allows), and no
// style, event handler or raw HTML from the document reaches the output.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const esc = escapeHtml;

export type HtmlOptions = {
  /**
   * The reference number for a citation mark's attrs, or null. When given,
   * each citation run is followed by `<sup class="cite"><a href="#ref-n">n</a></sup>`
   * (the print export's endnotes carry the matching ids).
   */
  citationNumber?: (attrs: Record<string, unknown>) => number | null;
  /** Relative links are made absolute against this origin; without it, same-site paths stay relative. */
  origin?: string;
  /** What an image src may be embedded as (a data: URI), or null to write its alt text. Without it, the default allow-list applies. */
  imageSrc?: (src: string) => string | null;
};

const MARK_TAG: Record<string, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
  highlight: "mark",
};

// Browsers ignore control characters and spaces inside a scheme ("java\tscript:").
const squash = (s: string) => s.replace(/[\u0000-\u0020\u007f]/g, "");

/** A link target that may be written, or null (text only). */
export function safeLinkHref(raw: unknown, origin?: string): string | null {
  if (typeof raw !== "string") return null;
  const h = squash(raw);
  if (!h) return null;
  if (/^(https?:|mailto:)/i.test(h) || /^#[\w.:-]*$/.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("\\")) return null;
  if (!origin) return h.startsWith("/") || h.startsWith("?") ? h : null;
  try {
    const url = new URL(h, origin);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i;

function imageSrcFor(raw: unknown, opts: HtmlOptions): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (opts.imageSrc) {
    const out = opts.imageSrc(raw);
    return out && DATA_IMAGE.test(out) ? out : null;
  }
  const h = squash(raw);
  if (DATA_IMAGE.test(h) || /^https:/i.test(h) || (h.startsWith("/") && !h.startsWith("//"))) return h;
  return null;
}

function citationNumbersOf(n: PMNode, opts: HtmlOptions): number[] {
  if (!opts.citationNumber) return [];
  const out = new Set<number>();
  for (const m of n.marks ?? []) {
    if (m.type !== "citation") continue;
    const num = opts.citationNumber(m.attrs ?? {});
    if (num) out.add(num);
  }
  return [...out].sort((a, b) => a - b);
}

function renderText(n: PMNode, opts: HtmlOptions): string {
  let html = esc(n.text ?? "");
  let cited = false;
  for (const m of n.marks ?? []) {
    if (m.type === "link") {
      const href = safeLinkHref(m.attrs?.href, opts.origin);
      if (href) html = `<a href="${esc(href)}">${html}</a>`;
    } else if (m.type === "citation") {
      // One span however many citations cover the text (their numbers follow the run).
      if (!cited) html = `<span class="citation">${html}</span>`;
      cited = true;
    } else {
      const tag = MARK_TAG[m.type];
      if (tag) html = `<${tag}>${html}</${tag}>`;
    }
  }
  return html;
}

/** The inline children of a textblock, with a superscript number after each citation run. */
function renderInline(kids: PMNode[], opts: HtmlOptions): string {
  const sets = kids.map((k) => citationNumbersOf(k, opts));
  return kids
    .map((k, i) => {
      const ending = sets[i].filter((num) => !(sets[i + 1] ?? []).includes(num));
      return renderNode(k, opts) + ending.map((num) => `<sup class="cite"><a href="#ref-${num}">${num}</a></sup>`).join("");
    })
    .join("");
}

const ALIGN = new Set(["center", "right", "justify"]);

const span = (v: unknown, name: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 && n < 1000 ? ` ${name}="${n}"` : "";
};

function renderNode(n: PMNode, opts: HtmlOptions): string {
  const kids = () => {
    const content = n.content ?? [];
    return content.some((c) => c.type === "text") ? renderInline(content, opts) : content.map((c) => renderNode(c, opts)).join("");
  };
  switch (n.type) {
    case "text":
      return renderText(n, opts);
    case "paragraph": {
      const align = String(n.attrs?.textAlign ?? "");
      const style = ALIGN.has(align) ? ` style="text-align:${align}"` : "";
      return `<p${style}>${kids()}</p>`;
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 2) || 2));
      return `<h${level}>${kids()}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${kids()}</ul>`;
    case "orderedList": {
      const start = Number(n.attrs?.start ?? 1);
      return `<ol${Number.isInteger(start) && start !== 1 && start >= 0 ? ` start="${start}"` : ""}>${kids()}</ol>`;
    }
    case "listItem":
      return `<li>${kids()}</li>`;
    case "blockquote":
      return `<blockquote>${kids()}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${esc((n.content ?? []).map((c) => c.text ?? "").join(""))}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    case "image": {
      const alt = String(n.attrs?.alt ?? "");
      const src = imageSrcFor(n.attrs?.src, opts);
      if (src) return `<img src="${esc(src)}" alt="${esc(alt)}">`;
      return n.attrs?.src ? `<span class="image-missing">[Image${alt.trim() ? `: ${esc(alt.trim())}` : ""}]</span>` : "";
    }
    case "table": {
      const rows = n.content ?? [];
      const headerRow = rows.length > 1 && (rows[0].content ?? []).length > 0 && (rows[0].content ?? []).every((c) => c.type === "tableHeader");
      const body = (headerRow ? rows.slice(1) : rows).map((r) => renderNode(r, opts)).join("");
      return headerRow ? `<table><thead>${renderNode(rows[0], opts)}</thead><tbody>${body}</tbody></table>` : `<table><tbody>${body}</tbody></table>`;
    }
    case "tableRow":
      return `<tr>${kids()}</tr>`;
    case "tableHeader":
      return `<th${span(n.attrs?.colspan, "colspan")}${span(n.attrs?.rowspan, "rowspan")}>${kids()}</th>`;
    case "tableCell":
      return `<td${span(n.attrs?.colspan, "colspan")}${span(n.attrs?.rowspan, "rowspan")}>${kids()}</td>`;
    default:
      return kids(); // unknown node: keep its children rather than dropping them
  }
}

/** Render a stored ProseMirror doc to HTML, without instantiating an editor. */
export function tiptapToHtml(doc: PMDoc | PMNode | null | undefined, opts: HtmlOptions = {}): string {
  if (!doc || !doc.content) return "";
  return doc.content.map((n) => renderNode(n, opts)).join("");
}

/** Flatten a ProseMirror doc to plain text (for content_text / preview / search). */
export function tiptapToText(doc: PMDoc | PMNode | null | undefined): string {
  if (!doc) return "";
  const out: string[] = [];
  const walk = (n: PMNode) => {
    if (n.text) out.push(n.text);
    if (n.type === "hardBreak") out.push("\n");
    if (n.content) n.content.forEach(walk);
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") out.push("\n");
  };
  (doc.content ?? []).forEach(walk);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}
