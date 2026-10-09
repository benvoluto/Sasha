// Word export (phase7-spec.md §4.3), with the `docx` library: the title, the
// body (headings, runs, links, nested lists, tables, images), one footnote per
// citation occurrence, and a References list at the end for readers who don't
// open footnotes. The type goes into the file's subject and keywords.
//
// Section ids, spec keys and filled marks are not written. SVG and WebP images
// (which Word can't take without a raster fallback) become "[Image: alt]".
// Server-only in practice (Packer builds a Buffer); pure otherwise.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import type { ResolvedReference } from "@/lib/citations/contract";
import type { PMNode } from "@/lib/documents/sections";
import { citationEnds, referenceHref, referenceLine, safeHref, staleNote, type ExportImage, type ExportInput } from "./contract";

/** Word's usable width at 1in margins on Letter, in the pixels ImageRun takes (96 dpi). */
const MAX_IMAGE_WIDTH_PX = 6.5 * 96;
const DEFAULT_IMAGE_SIZE = { width: 400, height: 300 };
const MAX_FOOTNOTE_EXCERPT = 200;
const MONO = "Consolas";

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const;

const DOCX_IMAGE_TYPE: Partial<Record<ExportImage["mime"], "png" | "jpg" | "gif">> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };

/** Image size in Word: the header's size, never wider than the text column, aspect kept. */
export function docxImageSize(image: Pick<ExportImage, "width" | "height">): { width: number; height: number } {
  const w = image.width ?? DEFAULT_IMAGE_SIZE.width;
  const h = image.height ?? DEFAULT_IMAGE_SIZE.height;
  if (w <= MAX_IMAGE_WIDTH_PX) return { width: w, height: h };
  return { width: MAX_IMAGE_WIDTH_PX, height: Math.round((h * MAX_IMAGE_WIDTH_PX) / w) };
}

// --- Numbering ------------------------------------------------------------------------

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const indentFor = (level: number) => ({ paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } });

const BULLET_LEVELS: ILevelsOptions[] = range(9).map((level) => ({
  level,
  format: LevelFormat.BULLET,
  text: ["•", "◦", "▪"][level % 3],
  alignment: AlignmentType.LEFT,
  style: indentFor(level),
}));

const NUMBER_LEVELS: ILevelsOptions[] = range(9).map((level) => ({
  level,
  format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
  text: `%${level + 1}.`,
  alignment: AlignmentType.LEFT,
  style: indentFor(level),
}));

// --- Conversion -------------------------------------------------------------------------

type Block = Paragraph | Table;

type ListContext = { reference: "bullets" | "numbers"; level: number; instance: number };

/**
 * Pure: `s` without the characters XML 1.0 forbids (C0 controls other than
 * tab, newline and carriage return; U+FFFE/U+FFFF; lone surrogates). `docx`
 * escapes markup but writes these as they are, and Word then calls the file
 * corrupt. They come in with PDF-extracted table cells and text pasted from
 * Word (vertical tab).
 */
export const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

type Ctx = {
  input: ExportInput;
  refs: Map<number, ResolvedReference>;
  footnotes: Record<number, { children: Paragraph[] }>;
  nextFootnote: number;
  nextInstance: number;
};

/** Inherited by nested blocks: bold in a header row, the left indent inside a blockquote or a list item. */
type RunStyle = { bold?: boolean; indent?: number };

function footnoteFor(ctx: Ctx, num: number): FootnoteReferenceRun {
  const id = ctx.nextFootnote++;
  const ref = ctx.refs.get(num);
  const text = `[${num}] ${ref ? referenceLine(ref, MAX_FOOTNOTE_EXCERPT) : `Reference ${num}`}`;
  ctx.footnotes[id] = { children: [new Paragraph({ children: [new TextRun(xmlSafe(text))] })] };
  return new FootnoteReferenceRun(id);
}

function imageRun(n: PMNode, ctx: Ctx): ParagraphChild {
  const src = typeof n.attrs?.src === "string" ? n.attrs.src : "";
  const alt = xmlSafe(String(n.attrs?.alt ?? "")).trim();
  const image = ctx.input.images.get(src);
  const type = image ? DOCX_IMAGE_TYPE[image.mime] : undefined;
  if (!image || !type) return new TextRun({ text: `[Image${alt ? `: ${alt}` : ""}]`, italics: true });
  return new ImageRun({
    type,
    data: image.data,
    transformation: docxImageSize(image),
    altText: { name: alt || "Image", description: alt, title: alt },
  });
}

function textRun(n: PMNode, style: RunStyle, linked: boolean): TextRun {
  const has = (t: string) => (n.marks ?? []).some((m) => m.type === t);
  const code = has("code");
  const opts: IRunOptions = {
    text: xmlSafe(n.text ?? ""),
    bold: style.bold || has("bold") || undefined,
    italics: has("italic") || undefined,
    underline: has("underline") ? {} : undefined,
    strike: has("strike") || undefined,
    highlight: has("highlight") ? "yellow" : undefined,
    ...(code ? { font: MONO, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } } : {}),
    ...(linked ? { style: "Hyperlink" } : {}),
  };
  return new TextRun(opts);
}

/** A textblock's inline children as runs, with a footnote reference after each citation run. */
function inlineRuns(inlines: PMNode[], ctx: Ctx, style: RunStyle = {}): ParagraphChild[] {
  const ends = citationEnds(inlines, ctx.input.numberOf);
  const out: ParagraphChild[] = [];
  inlines.forEach((n, i) => {
    if (n.type === "text") {
      const link = (n.marks ?? []).find((m) => m.type === "link");
      const href = link ? safeHref(link.attrs?.href, ctx.input.origin) : null;
      out.push(href ? new ExternalHyperlink({ link: href, children: [textRun(n, style, true)] }) : textRun(n, style, false));
    } else if (n.type === "hardBreak") out.push(new TextRun({ text: "", break: 1 }));
    else if (n.type === "image") out.push(imageRun(n, ctx));
    for (const num of ends[i] ?? []) out.push(footnoteFor(ctx, num));
  });
  return out;
}

const isInline = (n: PMNode) => n.type === "text" || n.type === "hardBreak";

function listBlocks(n: PMNode, ctx: Ctx, parent: ListContext | null, style: RunStyle): Block[] {
  const reference = n.type === "orderedList" ? "numbers" : "bullets";
  const level = parent ? Math.min(8, parent.level + 1) : 0;
  // Every ordered list restarts its count (a new instance); bullets share one.
  const instance = reference === "numbers" ? ctx.nextInstance++ : 0;
  const list: ListContext = { reference, level, instance };
  const out: Block[] = [];
  for (const item of n.content ?? []) {
    const kids = item.content ?? [];
    // The item's first paragraph carries the number or bullet; later paragraphs are indented to match.
    const numbered = kids[0] && kids[0].type === "paragraph" ? kids[0] : null;
    out.push(new Paragraph({ children: numbered ? inlineRuns(numbered.content ?? [], ctx, style) : [], numbering: list }));
    for (const child of numbered ? kids.slice(1) : kids) {
      if (child.type === "bulletList" || child.type === "orderedList") out.push(...listBlocks(child, ctx, list, style));
      else out.push(...blockToDocx(child, ctx, { ...style, indent: 720 * (level + 1) }));
    }
  }
  return out;
}

function tableToDocx(n: PMNode, ctx: Ctx): Table | null {
  const rows = (n.content ?? []).filter((r) => (r.content ?? []).length);
  if (!rows.length) return null;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, r) => {
      const header = r === 0 && (row.content ?? []).every((c) => c.type === "tableHeader");
      return new TableRow({
        tableHeader: header || undefined,
        children: (row.content ?? []).map((cell) => {
          const blocks = (cell.content ?? []).flatMap((b) => blockToDocx(b, ctx, { bold: header || cell.type === "tableHeader" }));
          const colspan = Number(cell.attrs?.colspan);
          return new TableCell({
            children: blocks.length ? blocks : [new Paragraph("")],
            ...(Number.isInteger(colspan) && colspan > 1 ? { columnSpan: colspan } : {}),
          });
        }),
      });
    }),
  });
}

function blockToDocx(n: PMNode, ctx: Ctx, style: RunStyle): Block[] {
  switch (n.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 2) || 2));
      return [new Paragraph({ heading: HEADINGS[level - 1], children: inlineRuns(n.content ?? [], ctx, style) })];
    }
    case "paragraph": {
      const align = n.attrs?.textAlign;
      const alignment = align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : align === "justify" ? AlignmentType.JUSTIFIED : undefined;
      return [new Paragraph({ children: inlineRuns(n.content ?? [], ctx, style), alignment, ...(style.indent ? { indent: { left: style.indent } } : {}) })];
    }
    case "bulletList":
    case "orderedList":
      return listBlocks(n, ctx, null, { bold: style.bold });
    case "blockquote":
      return (n.content ?? []).flatMap((c) => blockToDocx(c, ctx, { ...style, indent: (style.indent ?? 0) + 720 }));
    case "codeBlock": {
      const text = (n.content ?? []).map((c) => c.text ?? "").join("");
      return text.split("\n").map(
        (line) =>
          new Paragraph({
            spacing: { after: 0 },
            shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" },
            children: [new TextRun({ text: xmlSafe(line), font: MONO, size: 19 })],
          }),
      );
    }
    case "horizontalRule":
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] })];
    case "image":
      return [new Paragraph({ children: [imageRun(n, ctx)] })];
    case "table": {
      const t = tableToDocx(n, ctx);
      // Word needs a paragraph between adjacent tables (and after a table at a cell's end).
      return t ? [t, new Paragraph("")] : [];
    }
    default:
      if (n.content?.some(isInline)) return [new Paragraph({ children: inlineRuns(n.content, ctx, style) })];
      return (n.content ?? []).flatMap((c) => blockToDocx(c, ctx, style));
  }
}

function referencesBlocks(ctx: Ctx): Paragraph[] {
  const refs = ctx.input.references;
  if (!refs.length) return [];
  const instance = ctx.nextInstance++;
  const out = [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("References")] })];
  for (const r of refs) {
    const href = referenceHref(r, ctx.input.origin);
    const line = xmlSafe(referenceLine(r, MAX_FOOTNOTE_EXCERPT));
    out.push(
      new Paragraph({
        numbering: { reference: "numbers", level: 0, instance },
        children: [href ? new ExternalHyperlink({ link: href, children: [new TextRun({ text: line, style: "Hyperlink" })] }) : new TextRun(line)],
      }),
    );
  }
  const note = staleNote(refs);
  if (note) out.push(new Paragraph({ children: [new TextRun({ text: xmlSafe(note), italics: true })] }));
  return out;
}

/** The Word document for `input`. */
export function buildDocx(input: ExportInput): Document {
  const ctx: Ctx = {
    input,
    refs: new Map(input.references.map((r) => [r.number, r])),
    footnotes: {},
    nextFootnote: 1,
    nextInstance: 1,
  };
  const title = xmlSafe(input.title).trim() || "Untitled document";
  const typeTitle = xmlSafe(input.typeTitle ?? "").trim();
  const children: Block[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  if (typeTitle) children.push(new Paragraph({ children: [new TextRun({ text: typeTitle, italics: true, color: "555555" })] }));
  for (const block of input.doc.content ?? []) children.push(...blockToDocx(block, ctx, {}));
  children.push(...referencesBlocks(ctx));

  return new Document({
    creator: "Sasha",
    title,
    subject: typeTitle,
    keywords: xmlSafe(input.typeKey ?? ""),
    description: typeTitle ? `${typeTitle}, exported from Sasha` : "Exported from Sasha",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        { reference: "bullets", levels: BULLET_LEVELS },
        { reference: "numbers", levels: NUMBER_LEVELS },
      ],
    },
    footnotes: ctx.footnotes,
    sections: [{ properties: {}, children }],
  });
}

/** The .docx bytes for `input`. */
export async function exportDocx(input: ExportInput): Promise<Buffer> {
  return Packer.toBuffer(buildDocx(input));
}
