import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { blobAccess } from "@/lib/blob-access";
import { requireTeam } from "@/lib/documents/team";
import { checkModelCallLimit } from "@/lib/limits/http";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { sourceBlobPath } from "@/lib/sources/blob-paths";
import { createSource, linkSource, targetFolder } from "@/lib/sources/store";
import { DIRECT_UPLOAD_CONFIG, resolveUploadType } from "@/lib/upload-strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  files: z
    .array(z.object({ name: z.string().trim().min(1).max(300), size: z.number().int().nonnegative(), type: z.string().max(200) }))
    .min(1)
    .max(DIRECT_UPLOAD_CONFIG.maxFiles),
  folder_id: z.string().uuid().nullable().optional(),
  /** Put the files in this document's folder and link them to it. */
  document_id: z.string().uuid().nullable().optional(),
});

/**
 * POST /api/upload/presign — step one of an upload. Creates a source row per
 * file (status "uploading") and returns where each file goes. The client then
 * calls `upload(fields.blobPath, file, { access: fields.access, handleUploadUrl:
 * "/api/upload/direct", clientPayload: JSON.stringify({ sourceId }), contentType:
 * fields.contentType })` and finishes with /api/upload/complete. `access` is the
 * store's (blob-access.ts): a private store refuses a public upload.
 * Complete counts one "ingest" call per file; presign checks (without
 * counting) that the allowance has room for them all and answers 429 when it
 * hasn't, so nobody uploads files only to have them refused.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "No files to upload." }, { status: 400 });
  const { files, folder_id, document_id } = parsed.data;

  const maxMb = DIRECT_UPLOAD_CONFIG.maxFileSize / 1024 / 1024;
  const typed: Array<{ name: string; size: number; mime: string }> = [];
  for (const f of files) {
    if (f.size > DIRECT_UPLOAD_CONFIG.maxFileSize) return NextResponse.json({ error: `${f.name} is larger than ${maxMb} MB.` }, { status: 400 });
    if (f.size === 0) return NextResponse.json({ error: `${f.name} is empty.` }, { status: 400 });
    const mime = resolveUploadType(f.name, f.type);
    if (!mime) return NextResponse.json({ error: `${f.name} isn't a supported file type (PDF, Word, image, text, Markdown, CSV or Excel).` }, { status: 400 });
    typed.push({ name: f.name, size: f.size, mime });
  }

  const limited = await checkModelCallLimit(caller, "ingest", { cost: typed.length });
  if (limited) return limited;

  const target = await targetFolder(caller.teamId, caller.agent, { folderId: folder_id, documentId: document_id });
  if (!target.ok) {
    return NextResponse.json({ error: target.reason === "document_not_found" ? "Document not found." : "Folder not found." }, { status: 404 });
  }

  const uploads = [];
  for (const f of typed) {
    const sourceId = randomUUID();
    const blobPath = sourceBlobPath(caller.teamId, sourceId, f.name);
    await createSource(caller.teamId, caller.agent, {
      id: sourceId,
      kind: "file",
      folder_id: target.folderId,
      filename: f.name,
      mime: f.mime,
      bytes: f.size,
      blob_pathname: blobPath,
      extraction_status: "uploading",
    });
    if (document_id) await linkSource(caller.teamId, caller.agent, document_id, sourceId);
    uploads.push({
      sourceId,
      fileName: f.name,
      uploadUrl: "/api/upload/direct",
      fields: { sourceId, blobPath, access: blobAccess(), contentType: f.mime, fileName: f.name, fileSize: String(f.size) },
    });
  }
  return NextResponse.json({ uploads, folder_id: target.folderId });
}
