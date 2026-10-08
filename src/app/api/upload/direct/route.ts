import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { SOURCE_BLOB_PATH_RE } from "@/lib/sources/blob-paths";
import { getSource } from "@/lib/sources/store";
import { DIRECT_UPLOAD_CONFIG, TEXT_MIME_TYPES } from "@/lib/upload-strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/upload/direct — issues the browser a one-time token to put one
 * file straight into Blob (the `handleUploadUrl` of `upload()` from
 * @vercel/blob/client). A token is only issued for a source the caller's team
 * created through /api/upload/presign that is still uploading, and only for
 * the exact path presign chose; the store adds a random suffix to the name.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) return NextResponse.json({ error: "Invalid upload request." }, { status: 400 });

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const caller = await requireTeam(PERMISSIONS.sourceWrite);
        if (caller instanceof NextResponse) throw new Error("Sign in to upload.");
        let sourceId: unknown;
        try {
          sourceId = JSON.parse(clientPayload || "{}").sourceId;
        } catch {
          sourceId = undefined;
        }
        if (typeof sourceId !== "string") throw new Error("Missing upload details.");
        const source = await getSource(caller.teamId, sourceId);
        if (!source || source.kind !== "file") throw new Error("Upload not found.");
        if (source.extraction_status !== "uploading") throw new Error("This file has already been uploaded.");
        if (!SOURCE_BLOB_PATH_RE.test(pathname) || pathname !== source.blob_pathname) throw new Error("Invalid upload path.");
        const mime = source.mime ?? "application/octet-stream";
        // Browsers may label text files text/plain; accept that for the text types.
        const allowed = TEXT_MIME_TYPES.includes(mime) ? [...new Set([mime, "text/plain"])] : [mime];
        return {
          allowedContentTypes: allowed,
          maximumSizeInBytes: DIRECT_UPLOAD_CONFIG.maxFileSize,
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ sourceId: source.id, teamId: caller.teamId }),
        };
      },
      // Completion is reported by the client through /api/upload/complete, which
      // checks the caller's team; this webhook (when it can reach us) only logs.
      onUploadCompleted: async ({ blob }) => {
        console.log("[DirectUpload] stored", blob.pathname);
      },
    });
    return NextResponse.json(json);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed." }, { status: 400 });
  }
}
