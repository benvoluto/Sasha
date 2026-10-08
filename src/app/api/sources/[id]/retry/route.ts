import { after, NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { findPresignedUpload } from "@/lib/sources/blobs";
import { ingestSource } from "@/lib/sources/ingest";
import { getSource, setSourceFile, setSourceStatus, toSummary, type SourceRecord } from "@/lib/sources/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // ingest runs in after() and shares this budget

type Ctx = { params: Promise<{ id: string }> };

const NOT_UPLOADED = "This file hasn't finished uploading. Remove it and upload it again.";

/**
 * A file whose upload reached Blob but was never reported (the tab closed, or
 * completing failed): record the file presign's path points at, so it can be read.
 */
async function adoptUpload(teamId: string, source: SourceRecord): Promise<boolean> {
  if (source.kind !== "file" || !source.blob_pathname) return false;
  try {
    const blob = await findPresignedUpload(teamId, source.id, source.blob_pathname);
    if (!blob) return false;
    return !!(await setSourceFile(teamId, source.id, { blob_url: blob.url, blob_pathname: blob.pathname, bytes: blob.size, mime: source.mime, status: "pending" }));
  } catch (error) {
    console.error(`[Sources] could not look for the upload of source ${source.id}:`, error);
    return false;
  }
}

/**
 * POST /api/sources/[id]/retry — read the source again: after an error, one
 * that looks stuck, or a file whose upload finished but was never completed.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const { teamId, agent } = caller;
  const source = await getSource(teamId, (await params).id);
  if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });
  if (source.extraction_status === "uploading") {
    if (!(await adoptUpload(teamId, source))) return NextResponse.json({ error: NOT_UPLOADED }, { status: 409 });
  } else {
    await setSourceStatus(teamId, source.id, "pending");
  }
  after(() => ingestSource(teamId, source.id, agent));
  const current = await getSource(teamId, source.id);
  return NextResponse.json({ source: toSummary(current ?? source) });
}
