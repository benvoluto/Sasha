// Pure-JS markdown → ProseMirror/Tiptap JSON converter for the report editor.
// Targets the StarterKit node/mark names the editor uses (heading, paragraph,
// bulletList/orderedList/listItem, bold, italic, horizontalRule), so generated
// content loads into Tiptap without any node being silently dropped. No DOM and
// no Tiptap import needed — it emits plain ProseMirror JSON.
//
// Scope: the subset the model is asked to produce (headings, paragraphs, lists,
// bold/italic, rules, and GFM pipe tables). Figure-heavy content renders as tables.

export type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: { type: string }[] };
export type PMDoc = { type: "doc"; content: PMNode[] };

export function emptyDoc(): PMDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

// Inline **bold**, *italic* / _italic_ → text nodes with marks. Minimal but safe.
function inline(text: string): PMNode[] {
  const nodes: PMNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ type: "text", text: text.slice(last, m.index) });
    if (m[2] !== undefined) nodes.push({ type: "text", text: m[2], marks: [{ type: "bold" }] });
    else if (m[4] !== undefined) nodes.push({ type: "text", text: m[4], marks: [{ type: "italic" }] });
    else if (m[6] !== undefined) nodes.push({ type: "text", text: m[6], marks: [{ type: "italic" }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.length ? nodes : [{ type: "text", text }];
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

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

const MARK_TAG: Record<string, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
};

function renderText(n: PMNode): string {
  let html = esc(n.text ?? "");
  for (const mark of n.marks ?? []) {
    const m = mark as { type: string; attrs?: Record<string, unknown> };
    if (m.type === "link") {
      const href = esc(String(m.attrs?.href ?? ""));
      html = `<a href="${href}">${html}</a>`;
    } else {
      const tag = MARK_TAG[m.type];
      if (tag) html = `<${tag}>${html}</${tag}>`;
    }
  }
  return html;
}

function renderNode(n: PMNode): string {
  const kids = () => (n.content ?? []).map(renderNode).join("");
  switch (n.type) {
    case "text":
      return renderText(n);
    case "paragraph": {
      const align = n.attrs?.textAlign;
      const style = align && align !== "left" ? ` style="text-align:${esc(String(align))}"` : "";
      return `<p${style}>${kids()}</p>`;
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 2)));
      return `<h${level}>${kids()}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${kids()}</ul>`;
    case "orderedList":
      return `<ol>${kids()}</ol>`;
    case "listItem":
      return `<li>${kids()}</li>`;
    case "blockquote":
      return `<blockquote>${kids()}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${kids()}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    case "image": {
      const src = esc(String(n.attrs?.src ?? ""));
      const alt = esc(String(n.attrs?.alt ?? ""));
      return src ? `<img src="${src}" alt="${alt}">` : "";
    }
    case "table":
      return `<table>${kids()}</table>`;
    case "tableRow":
      return `<tr>${kids()}</tr>`;
    case "tableHeader":
      return `<th>${kids()}</th>`;
    case "tableCell":
      return `<td>${kids()}</td>`;
    default:
      return kids(); // unknown node: keep its children rather than dropping them
  }
}

/** Render a stored ProseMirror doc to HTML, without instantiating an editor. */
export function tiptapToHtml(doc: PMDoc | PMNode | null | undefined): string {
  if (!doc || !doc.content) return "";
  return doc.content.map(renderNode).join("");
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
