import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { del, put } from "@vercel/blob";
import { processDocumentsWithGemini } from "@/lib/gemini";
import { hasReadableText } from "@/lib/extracted-text";
import { fetchGroupMetadata } from "@/lib/ontology/group-metadata";
import { withTimeout, friendlyProcessingError, writeProcessingError } from "@/lib/processing-status";
import { getUserIdentifier } from "@/lib/auth";
import type { GroupMetadata } from "@/lib/sources/split";
import { blobAccess } from "@/lib/blob-access";

export const runtime = "nodejs";
export const maxDuration = 300;

const EXTRACTION_TIMEOUT_MS = 240000;

/**
 * POST /api/cases/[groupId]/documents  (multipart: files[])
 * Adds source files to an existing document: uploads the new files, records
 * them on the upload group, then re-extracts the new files and appends their
 * text to the group's extracted content.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;

  const uploader = await getUserIdentifier();
  if (!uploader) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const existing = (await fetchGroupMetadata(groupId)) as (GroupMetadata & Record<string, unknown>) | null;
  if (!existing) return NextResponse.json({ error: "document not found", groupId }, { status: 404 });

  const form = await request.formData();
  const incoming = form.getAll("files").filter((f): f is File => f instanceof File);
  if (incoming.length === 0) return NextResponse.json({ error: "no files provided" }, { status: 400 });

  // Upload each new file to the group's blob folder and collect buffers for extraction.
  const stamp = Date.now();
  const newFiles: Array<{ buffer: Buffer; name: string; type: string }> = [];
  const newFileMeta: Array<{ name: string; url: string; size: number; type: string }> = [];
  for (let i = 0; i < incoming.length; i++) {
    const file = incoming[i];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (ext !== "pdf" && ext !== "docx") continue;
    const buffer = Buffer.from(await file.arrayBuffer());
    const blob = await put(`upload-groups/${groupId}/files/add-${stamp}-${i}-${file.name}`, buffer, {
      access: blobAccess(),
      contentType: file.type || (ext === "pdf" ? "application/pdf" : "application/octet-stream"),
      allowOverwrite: true,
    });
    newFiles.push({ buffer, name: file.name, type: ext });
    newFileMeta.push({ name: file.name, url: blob.url, size: file.size, type: file.type });
  }
  if (newFiles.length === 0) return NextResponse.json({ error: "no PDF/DOCX files provided" }, { status: 400 });

  // Record the new files and mark the group as processing again.
  const files = [...((existing.files as typeof newFileMeta) ?? []), ...newFileMeta];
  const baseMetadata = {
    ...existing,
    files,
    geminiProcessing: { ...(existing.geminiProcessing ?? {}), status: "processing" as const },
  };
  const metadataPath = `upload-groups/${groupId}/metadata.json`;
  await put(metadataPath, JSON.stringify(baseMetadata), { access: blobAccess(), contentType: "application/json", allowOverwrite: true });

  // Re-extract the new files and fold them into the group's text.
  after(async () => {
    try {
      const result = await withTimeout(processDocumentsWithGemini(newFiles), EXTRACTION_TIMEOUT_MS, "Gemini extraction");
      const priorText = (existing.geminiProcessing as { extractedContent?: string } | undefined)?.extractedContent ?? "";
      // Nothing read from the new files leaves the group's text as it was; the
      // error still says which files could not be read.
      const combined =
        result.status === "error"
          ? priorText
          : `${priorText}\n\n=== Additional documents (added ${new Date(stamp).toISOString()}) ===\n\n${result.extractedContent}`.trim();
      const status = result.status === "success" ? ("completed" as const) : result.status === "error" && hasReadableText(priorText) ? ("partial" as const) : result.status;

      const updated = {
        ...baseMetadata,
        geminiProcessing: {
          // Reflect the real extraction outcome rather than always "completed" —
          // otherwise a failed or partial read of the added documents is invisible.
          status,
          extractedContent: combined,
          ...(result.error ? { error: result.error } : {}),
          processedAt: new Date().toISOString(),
          fileCount: files.length,
        },
      };
      await put(metadataPath, JSON.stringify(updated), { access: blobAccess(), contentType: "application/json", allowOverwrite: true });
    } catch (error) {
      console.error(`[AddDocuments] processing failed for ${groupId}:`, error);
      await writeProcessingError(groupId, baseMetadata, friendlyProcessingError(error));
    }
  });

  return NextResponse.json({ ok: true, groupId, added: newFiles.length, totalFiles: files.length });
}

/**
 * DELETE /api/cases/[groupId]/documents   Body: { url }
 * Remove one uploaded file from a document — the fix for a duplicate upload.
 *
 * Targeted by URL, not name: re-uploading the same file produces two entries
 * with an identical `name` but distinct blob URLs, so a name would be ambiguous
 * for exactly the situation this exists to handle.
 *
 * Removing a file changes the source text, so the remaining files are
 * re-extracted. Without that the deleted file's text would linger in
 * `extractedContent` (still feeding search and phrase matching).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;

  const caller = await getUserIdentifier();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body with a file url is required" }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  const existing = (await fetchGroupMetadata(groupId)) as (GroupMetadata & Record<string, unknown>) | null;
  if (!existing) return NextResponse.json({ error: "document not found", groupId }, { status: 404 });

  const allFiles = (existing.files as Array<{ name?: string; url?: string; type?: string }> | undefined) ?? [];
  const target = allFiles.find((f) => f.url === url);
  if (!target) return NextResponse.json({ error: "file not found on this document" }, { status: 404 });

  const remaining = allFiles.filter((f) => f.url !== url);
  const metadataPath = `upload-groups/${groupId}/metadata.json`;
  const baseMetadata = {
    ...existing,
    files: remaining,
    geminiProcessing: { ...(existing.geminiProcessing ?? {}), status: "processing" as const },
  };
  await put(metadataPath, JSON.stringify(baseMetadata), { access: blobAccess(), contentType: "application/json", allowOverwrite: true });

  // Best-effort: the group record is the source of truth, so a failed blob delete
  // must not fail the request.
  try {
    await del(url);
  } catch (error) {
    console.error(`[DeleteDocument] blob delete failed for ${url} (non-fatal):`, error);
  }

  after(async () => {
    try {
      if (remaining.length === 0) {
        await put(
          metadataPath,
          JSON.stringify({ ...baseMetadata, geminiProcessing: { status: "completed" as const, extractedContent: "", processedAt: new Date().toISOString(), fileCount: 0 } }),
          { access: blobAccess(), contentType: "application/json", allowOverwrite: true },
        );
        return;
      }
      const sources = remaining
        .filter((f) => f.url)
        .map((f) => ({ url: f.url as string, name: f.name ?? "document", type: (f.name ?? "").toLowerCase().endsWith(".docx") ? "docx" : "pdf" }));
      const result = await withTimeout(processDocumentsWithGemini(sources), EXTRACTION_TIMEOUT_MS, "Gemini extraction");

      const updated = {
        ...baseMetadata,
        geminiProcessing: {
          status: result.status === "success" ? ("completed" as const) : result.status,
          extractedContent: result.extractedContent,
          ...(result.error ? { error: result.error } : {}),
          processedAt: new Date().toISOString(),
          fileCount: remaining.length,
        },
      };
      await put(metadataPath, JSON.stringify(updated), { access: blobAccess(), contentType: "application/json", allowOverwrite: true });
    } catch (error) {
      console.error(`[DeleteDocument] reprocessing failed for ${groupId}:`, error);
      await writeProcessingError(groupId, baseMetadata, friendlyProcessingError(error));
    }
  });

  return NextResponse.json({ ok: true, groupId, removed: target.name ?? url, remaining: remaining.length });
}
