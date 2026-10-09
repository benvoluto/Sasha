// Markdown export (phase7-spec.md §4.2): the stored document as GFM, the
// inverse of markdownToTiptap for the subset it reads (headings, paragraphs,
// flat lists, bold, italic, rules, pipe tables), plus what it doesn't read
// back: nested lists, links, code, strike, underline (<u>), highlight (==),
// blockquotes, images and citations. Citations are reference-style links,
// `[\[n\]][n]`, with a References section and link definitions at the end.
//
// Pure: the route resolves references and images before calling it.

import type { PMNode } from "@/lib/documents/sections";
import { citationEnds, flatten, referenceHref, referenceLabel, referenceLine, safeHref, staleNote, type ExportInput } from "./contract";

/** Data URIs larger than this are written as "[Image: alt]" (a Markdown file with megabytes on one line helps no one). */
export const MAX_MARKDOWN_DATA_URI = 200 * 1024;

export type MarkdownExportOptions = Pick<ExportInput, "numberOf" | "references" | "origin"> &
  Partial<Pick<ExportInput, "title" | "images">>;

// --- Escaping -----------------------------------------------------------------------

/** Escapes inline text: Markdown punctuation everywhere, `|` inside table cells. */
function escapeInline(text: string, inTable: boolean): string {
  let s = text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`).replace(/~~/g, "\\~\\~").replace(/==/g, "\\=\\=");
  if (inTable) s = s.replace(/\|/g, "\\|");
  return s;
}

/** Escapes what would start a block at the beginning of a line: a heading, a list item, a quote, a rule. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+-])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(\s|$)/, "$1\\$2$3");
}

// --- Inline content -------------------------------------------------------------------

type Mark = NonNullable<PMNode["marks"]>[number];

/** Marks in nesting order, outermost first; code is written as a span inside them; anything else (filled, citation…) is not written. */
const MARK_ORDER = ["link", "bold", "italic", "strike", "underline", "highlight"] as const;
type MarkType = (typeof MARK_ORDER)[number];

type OpenMark = { type: MarkType; href?: string | null };

function openMarks(n: PMNode, origin: string): OpenMark[] {
  const out: OpenMark[] = [];
  for (const type of MARK_ORDER) {
    const m = (n.marks ?? []).find((x: Mark) => x.type === type);
    if (!m) continue;
    if (type === "link") {
      const href = safeHref(m.attrs?.href, origin);
      if (href) out.push({ type, href });
    } else out.push({ type });
  }
  return out;
}

const sameMark = (a: OpenMark, b: OpenMark) => a.type === b.type && (a.href ?? null) === (b.href ?? null);

function openTag(m: OpenMark): string {
  switch (m.type) {
    case "link":
      return "[";
    case "bold":
      return "**";
    case "italic":
      return "_";
    case "strike":
      return "~~";
    case "underline":
      return "<u>";
    case "highlight":
      return "==";
  }
}

function closeTag(m: OpenMark): string {
  switch (m.type) {
    case "link":
      return `](${linkTarget(m.href ?? "")})`;
    case "underline":
      return "</u>";
    default:
      return openTag(m);
  }
}

/** A link destination: wrapped in <> when it has spaces or parentheses. */
const linkTarget = (href: string) => (/[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href);

const citeRef = (n: number) => `[\\[${n}\\]][${n}]`;

function imageMarkdown(n: PMNode, opts: MarkdownExportOptions): string {
  const alt = String(n.attrs?.alt ?? n.attrs?.title ?? "").trim();
  const src = String(n.attrs?.src ?? "");
  const image = opts.images?.get(src);
  if (image && image.dataUri.length <= MAX_MARKDOWN_DATA_URI) return `![${escapeInline(alt, false)}](${image.dataUri})`;
  return `\\[Image${alt ? `: ${escapeInline(alt, false)}` : ""}\\]`;
}

/**
 * The inline children of a textblock. Marks open and close like a stack, so
 * `**bold _both_**` nests instead of writing adjacent `****`; whitespace at a
 * run's edge moves outside the delimiters (emphasis can't start or end with a
 * space). A citation number follows the end of its run.
 */
function inlineMarkdown(inlines: PMNode[], opts: MarkdownExportOptions, inTable: boolean): string {
  const ends = citationEnds(inlines, opts.numberOf);
  const stack: OpenMark[] = [];
  let out = "";
  let pendingSpace = "";
  const closeTo = (depth: number) => {
    while (stack.length > depth) out += closeTag(stack.pop()!);
  };

  inlines.forEach((n, i) => {
    if (n.type === "hardBreak") {
      closeTo(0);
      out += pendingSpace.replace(/\n/g, " ");
      pendingSpace = "";
      out += inTable ? "<br>" : "  \n";
    } else if (n.type === "image") {
      closeTo(0);
      out += pendingSpace + imageMarkdown(n, opts);
      pendingSpace = "";
    } else if (n.type === "text") {
      const text = (n.text ?? "").replace(/\n/g, " ");
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? ["", "", text, ""];
      if (!core) {
        pendingSpace += text;
      } else {
        const want = openMarks(n, opts.origin);
        let common = 0;
        while (common < stack.length && common < want.length && sameMark(stack[common], want[common])) common++;
        closeTo(common);
        out += pendingSpace + lead;
        pendingSpace = "";
        for (const m of want.slice(common)) {
          out += openTag(m);
          stack.push(m);
        }
        out += n.marks?.some((m) => m.type === "code") ? codeSpan(inTable ? core.replace(/\|/g, "\\|") : core) : escapeInline(core, inTable);
        pendingSpace = trail;
      }
    }
    if (ends[i]?.length) {
      closeTo(0);
      out += ends[i].map(citeRef).join("");
    }
  });
  closeTo(0);
  return out + pendingSpace.trimEnd();
}

/** A code span: fenced by one more backtick than the longest run inside, padded when the text starts or ends with one. */
function codeSpan(text: string): string {
  const f = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${f}${pad}${text}${pad}${f}`;
}

// --- Blocks -----------------------------------------------------------------------------

const indent = (text: string, pad: string) =>
  text
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : pad + l))
    .join("\n");

function listMarkdown(n: PMNode, opts: MarkdownExportOptions): string {
  const ordered = n.type === "orderedList";
  const start = ordered ? Math.max(0, Number(n.attrs?.start ?? 1) || 1) : 0;
  return (n.content ?? [])
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : "- ";
      const blocks = (item.content ?? []).map((b, j) => {
        const md = blockMarkdown(b, opts);
        // A nested list follows its paragraph directly (tight); further paragraphs get a blank line.
        return j === 0 ? md : (b.type === "bulletList" || b.type === "orderedList" ? "\n" : "\n\n") + md;
      });
      const body = blocks.join("") || "";
      return marker + indent(body, " ".repeat(marker.length));
    })
    .join("\n");
}

function tableMarkdown(n: PMNode, opts: MarkdownExportOptions): string {
  const rows = (n.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((b) => (b.content?.some((c) => c.type === "text" || c.type === "hardBreak") ? inlineMarkdown(b.content, opts, true) : plainCell(b, opts)))
        .filter(Boolean)
        .join("<br>"),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] || " ").join(" | ")} |`;
  return [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/** A block inside a cell that isn't a textblock (a list): its text, one line per item. */
function plainCell(b: PMNode, opts: MarkdownExportOptions): string {
  const parts: string[] = [];
  const walk = (x: PMNode) => {
    if (x.content?.some((c) => c.type === "text")) parts.push(inlineMarkdown(x.content, opts, true));
    else (x.content ?? []).forEach(walk);
  };
  walk(b);
  return parts.join("<br>");
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(longest + 1);
}

function blockMarkdown(n: PMNode, opts: MarkdownExportOptions): string {
  switch (n.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 2) || 2));
      return `${"#".repeat(level)} ${inlineMarkdown(n.content ?? [], opts, false)}`.trimEnd();
    }
    case "paragraph": {
      const text = inlineMarkdown(n.content ?? [], opts, false);
      return text.split("\n").map(escapeLineStart).join("\n");
    }
    case "bulletList":
    case "orderedList":
      return listMarkdown(n, opts);
    case "blockquote":
      return blocksMarkdown(n.content ?? [], opts)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "codeBlock": {
      const text = (n.content ?? []).map((c) => c.text ?? "").join("");
      const f = fence(text);
      const lang = typeof n.attrs?.language === "string" ? n.attrs.language.replace(/[^\w+.-]/g, "") : "";
      return `${f}${lang}\n${text}\n${f}`;
    }
    case "horizontalRule":
      return "---";
    case "image":
      return imageMarkdown(n, opts);
    case "table":
      return tableMarkdown(n, opts);
    case "text":
    case "hardBreak":
      return inlineMarkdown([n], opts, false);
    default:
      // Unknown block: keep its children rather than dropping them.
      return n.content?.some((c) => c.type === "text") ? inlineMarkdown(n.content, opts, false) : blocksMarkdown(n.content ?? [], opts);
  }
}

function blocksMarkdown(blocks: PMNode[], opts: MarkdownExportOptions): string {
  return blocks
    .map((b) => blockMarkdown(b, opts))
    .filter((s) => s.trim() !== "")
    .join("\n\n");
}

// --- References -----------------------------------------------------------------------------

/**
 * Link-definition title: one line (a blank line would end the definition and
 * let the rest parse as top-level Markdown), with backslashes, double quotes
 * and `<`, `>`, `&` escaped so nothing in it can read as HTML or an entity.
 */
const defTitle = (s: string) => flatten(s).replace(/[\\"<>&]/g, (c) => `\\${c}`);

function referencesMarkdown(opts: MarkdownExportOptions): string {
  if (!opts.references.length) return "";
  const list = opts.references.map((r) => `${r.number}. ${escapeInline(flatten(referenceLine(r)), false)}`).join("\n");
  const note = staleNote(opts.references);
  const defs = opts.references
    .map((r) => `[${r.number}]: ${linkTarget(referenceHref(r, opts.origin) ?? "#references")} "${defTitle(referenceLabel(r))}"`)
    .join("\n");
  return ["## References", list, note ? `_${escapeInline(note, false)}_` : "", defs].filter(Boolean).join("\n\n");
}

/**
 * The document as Markdown: `# Title` (when given), the body, then References.
 * Ends with a single newline.
 */
export function tiptapToMarkdown(doc: PMNode, opts: MarkdownExportOptions): string {
  const title = flatten(opts.title ?? "");
  const parts = [
    title ? `# ${escapeInline(title, false)}` : "",
    blocksMarkdown(doc.content ?? [], opts),
    referencesMarkdown(opts),
  ].filter(Boolean);
  return `${parts.join("\n\n")}\n`;
}
