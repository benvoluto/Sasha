import { NextResponse } from "next/server";
import { getType } from "@/catalog";
import { resolveReferences } from "@/lib/citations/references";
import { getDocument } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { exportDocx } from "@/lib/export/docx";
import {
  EXPORT_HTML_CSP,
  EXPORT_MIME,
  ExportQuery,
  MAX_EXPORT_JSON_BYTES,
  contentDisposition,
  exportCitations,
  exportFilename,
  type ExportFallback,
  type ExportFormat,
  type ExportInput,
} from "@/lib/export/contract";
import { printHtml } from "@/lib/export/html";
import { resolveImages } from "@/lib/export/images";
import { tiptapToMarkdown } from "@/lib/export/markdown";
import { PdfBusyError, PdfTimeoutError, PdfTooLargeError, PdfUnavailableError, renderPdf } from "@/lib/export/pdf";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { processMemory } from "@/lib/process-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Launching Chrome and printing a long document takes a while.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const NOSNIFF = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

const error = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status, headers: NOSNIFF });

/** PDF exports in progress, by team, document, saved version and origin: a repeated identical export shares the first render. */
const pdfInflight = processMemory("export.pdfInflight", () => new Map<string, Promise<Uint8Array>>());

const FORMAT_NAME: Record<ExportFormat, string> = { md: "Markdown", docx: "Word", pdf: "PDF", html: "HTML" };

/**
 * GET /api/documents/[id]/export?format=md|docx|pdf|html — the stored document
 * as a file (phase7-spec.md §4.1). Citations become numbered references,
 * images are inlined only from data: URIs and the team's own source files,
 * and nothing in the document is ever executed. `html` is the print fallback,
 * served inline under a policy that forbids scripts and remote loads.
 */
export async function GET(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const url = new URL(req.url);
  const query = ExportQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return error("Choose a format: md, docx, pdf or html.", 400);
  const format = query.data.format;

  const doc = await getDocument(caller.teamId, (await params).id);
  if (!doc) return error("Document not found.", 404);
  if (Buffer.byteLength(JSON.stringify(doc.content_json ?? null)) > MAX_EXPORT_JSON_BYTES) {
    return error(`This document is too large to export as ${FORMAT_NAME[format]}.`, 413);
  }

  const started = Date.now();
  const origin = url.origin;
  const buildInput = async (): Promise<ExportInput> => {
    const { doc: content, references, numberOf } = exportCitations(doc.content_json);
    const [resolved, images, type] = await Promise.all([
      resolveReferences(caller.teamId, doc.id, references),
      resolveImages(content, { teamId: caller.teamId, origin }),
      getType(caller.teamId, doc.type_key).catch(() => null),
    ]);
    return {
      doc: content,
      title: doc.title,
      typeTitle: type?.definition.title ?? null,
      typeKey: type?.definition.key ?? doc.type_key ?? null,
      references: resolved,
      numberOf,
      origin,
      images,
    };
  };
  const pdf = () => {
    const key = [caller.teamId, doc.id, doc.updated_at, origin].join("\u0000");
    let running = pdfInflight.get(key);
    if (!running) {
      const job = (async () => new Uint8Array(await renderPdf(printHtml(await buildInput()))))();
      running = job;
      pdfInflight.set(key, job);
      void job.catch(() => undefined).finally(() => {
        if (pdfInflight.get(key) === job) pdfInflight.delete(key);
      });
    }
    return running;
  };

  let body: Uint8Array;
  try {
    if (format === "pdf") body = await pdf();
    else {
      const input = await buildInput();
      if (format === "md") body = new TextEncoder().encode(tiptapToMarkdown(input.doc, input));
      else if (format === "docx") body = new Uint8Array(await exportDocx(input));
      else body = new TextEncoder().encode(printHtml(input));
    }
  } catch (err) {
    if (err instanceof PdfUnavailableError) {
      const fallback: ExportFallback = { error: "PDF rendering isn't available here.", fallback: "print" };
      return NextResponse.json(fallback, { status: 503, headers: NOSNIFF });
    }
    if (err instanceof PdfBusyError) {
      return NextResponse.json({ error: "Too many PDFs are being made right now. Try again in a moment." }, { status: 429, headers: { ...NOSNIFF, "Retry-After": "10" } });
    }
    if (err instanceof PdfTooLargeError) return error("This document is too large to export as PDF.", 413);
    if (err instanceof PdfTimeoutError) return error("The PDF took too long to make. Try again, or export Word instead.", 504);
    console.error("[export] failed", { format, error: err instanceof Error ? err.message : "unknown" });
    return error(`The ${FORMAT_NAME[format]} export failed.`, 500);
  }

  console.info("[export]", { format, bytes: body.byteLength, ms: Date.now() - started });
  const headers = new Headers({ ...NOSNIFF, "Content-Type": EXPORT_MIME[format], "Content-Length": String(body.byteLength) });
  if (format === "html") {
    headers.set("Content-Security-Policy", EXPORT_HTML_CSP);
    headers.set("Content-Disposition", contentDisposition(exportFilename(doc.title, "pdf").replace(/\.pdf$/, ".html"), true));
    headers.set("Referrer-Policy", "no-referrer");
  } else {
    headers.set("Content-Disposition", contentDisposition(exportFilename(doc.title, format)));
  }
  return new Response(body as BodyInit, { status: 200, headers });
}
