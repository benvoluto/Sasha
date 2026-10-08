import { head } from "@vercel/blob";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { isOwnBlobUrl } from "@/lib/blob-host";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { blobPathnameOf, matchesPresignedPath, SOURCE_BLOB_PATH_RE } from "@/lib/sources/blob-paths";
import { ingestSource } from "@/lib/sources/ingest";
import { getSource, setSourceFile, toSummary, type SourceRecord, type SourceSummary } from "@/lib/sources/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // ingest runs in after() and shares this budget

const Body = z.object({
  uploads: z
    .array(
      z.object({
        sourceId: z.string().uuid(),
        url: z.string().url().max(2000),
        pathname: z.string().max(1000),
        size: z.number().optional(),
        type: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});

type Upload = z.infer<typeof Body>["uploads"][number];
type Outcome = { ok: true; source: SourceRecord; started: boolean } | { ok: false; error: string };

/**
 * Check one reported upload and record its file. It must be a source of the
 * caller's team that is still uploading, stored on our own Blob store at the
 * path presign chose. Size and type come from the store, not the request.
 */
async function finalize(teamId: string, u: Upload): Promise<Outcome> {
  const source = await getSource(teamId, u.sourceId);
  if (!source || source.kind !== "file") return { ok: false, error: "Upload not found." };
  if (source.extraction_status !== "uploading") {
    // A repeated report for a finished upload is harmless.
    if (source.blob_url === u.url) return { ok: true, source, started: false };
    return { ok: false, error: `${source.filename ?? "This file"} has already been uploaded.` };
  }
  const pathname = blobPathnameOf(u.url);
  const valid =
    isOwnBlobUrl(u.url) &&
    pathname !== null &&
    pathname === u.pathname &&
    SOURCE_BLOB_PATH_RE.test(pathname) &&
    !!source.blob_pathname &&
    matchesPresignedPath(pathname, source.blob_pathname);
  if (!valid) return { ok: false, error: `The upload of ${source.filename ?? "a file"} doesn't match what was requested.` };
  let meta: Awaited<ReturnType<typeof head>>;
  try {
    meta = await head(u.url);
  } catch {
    return { ok: false, error: `${source.filename ?? "A file"} wasn't found in storage. Upload it again.` };
  }
  // Keep presign's canonical type; the store's may be the browser's vaguer label.
  const updated = await setSourceFile(teamId, source.id, {
    blob_url: u.url,
    blob_pathname: pathname,
    bytes: meta.size,
    mime: source.mime ?? meta.contentType ?? null,
    status: "pending",
  });
  return updated ? { ok: true, source: updated, started: true } : { ok: false, error: "Upload not found." };
}

/**
 * POST /api/upload/complete — the browser reports finished uploads. Each is
 * checked and recorded on its own, so one bad report doesn't strand the rest:
 * the response lists the recorded sources and, per source id, the ones that
 * failed (the browser removes those). Reading the files starts in the
 * background.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid upload report." }, { status: 400 });
  const { teamId, agent } = caller;

  const sources: SourceSummary[] = [];
  const failed: Array<{ sourceId: string; error: string }> = [];
  const ids: string[] = [];
  for (const u of parsed.data.uploads) {
    const outcome = await finalize(teamId, u);
    if (!outcome.ok) {
      failed.push({ sourceId: u.sourceId, error: outcome.error });
      continue;
    }
    sources.push(toSummary(outcome.source));
    if (outcome.started) ids.push(outcome.source.id);
  }
  if (ids.length) after(() => Promise.all(ids.map((id) => ingestSource(teamId, id, agent))).then(() => undefined));
  return NextResponse.json({ sources, failed });
}
