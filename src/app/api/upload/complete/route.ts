import { head } from "@vercel/blob";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { isOwnBlobUrl } from "@/lib/blob-host";
import { headE2eBlob } from "@/lib/e2e/blob-store";
import { e2eStubBlob } from "@/lib/e2e/mode";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { contextFor, enterModelContext } from "@/lib/llm/context";
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
type Meta = Pick<Awaited<ReturnType<typeof head>>, "size" | "contentType">;
/** A checked report: already done (`file` null), or a file to record and read. */
type Checked = { ok: true; source: SourceRecord; file: { url: string; pathname: string; meta: Meta } | null } | { ok: false; error: string };

/**
 * Check one reported upload without writing anything. It must be a source of
 * the caller's team that is still uploading, stored on our own Blob store at
 * the path presign chose. Size and type come from the store, not the request.
 */
async function check(teamId: string, u: Upload): Promise<Checked> {
  const source = await getSource(teamId, u.sourceId);
  if (!source || source.kind !== "file") return { ok: false, error: "Upload not found." };
  if (source.extraction_status !== "uploading") {
    // A repeated report for a finished upload is harmless.
    if (source.blob_url === u.url) return { ok: true, source, file: null };
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
  let meta: Meta;
  try {
    // e2e runs (never production): the in-memory store (src/lib/e2e).
    meta = e2eStubBlob() ? headE2eBlob(u.url) : await head(u.url);
  } catch {
    return { ok: false, error: `${source.filename ?? "A file"} wasn't found in storage. Upload it again.` };
  }
  return { ok: true, source, file: { url: u.url, pathname, meta } };
}

/** Record a checked file; null when the source went away meanwhile. */
async function record(teamId: string, source: SourceRecord, file: NonNullable<Extract<Checked, { ok: true }>["file"]>): Promise<SourceRecord | null> {
  // Keep presign's canonical type; the store's may be the browser's vaguer label.
  return setSourceFile(teamId, source.id, {
    blob_url: file.url,
    blob_pathname: file.pathname,
    bytes: file.meta.size,
    mime: source.mime ?? file.meta.contentType ?? null,
    status: "pending",
  });
}

/**
 * POST /api/upload/complete — the browser reports finished uploads. Each is
 * checked and recorded on its own, so one bad report doesn't strand the rest:
 * the response lists the recorded sources and, per source id, the ones that
 * failed (the browser removes those). Reading the files starts in the
 * background. Every file that starts a read counts one "ingest" call; when
 * the allowance can't cover them all, nothing is recorded and the answer is
 * 429 (the files stay uploading).
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  enterModelContext(contextFor(caller));
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid upload report." }, { status: 400 });
  const { teamId, agent } = caller;

  const checked: Array<{ u: Upload; outcome: Checked }> = [];
  for (const u of parsed.data.uploads) {
    // The same file reported twice in one batch is recorded (and read) once.
    const earlier = checked.find((c) => c.u.sourceId === u.sourceId && c.outcome.ok);
    if (earlier?.outcome.ok) {
      const same = earlier.u.url === u.url;
      checked.push({ u, outcome: same ? { ok: true, source: earlier.outcome.source, file: null } : { ok: false, error: `${earlier.outcome.source.filename ?? "This file"} has already been uploaded.` } });
      continue;
    }
    checked.push({ u, outcome: await check(teamId, u) });
  }
  const toStart = checked.filter(({ outcome }) => outcome.ok && outcome.file).length;
  if (toStart) {
    const limited = await limitModelCall(caller, "ingest", { cost: toStart });
    if (limited) return limited;
  }

  const sources: SourceSummary[] = [];
  const failed: Array<{ sourceId: string; error: string }> = [];
  const ids: string[] = [];
  for (const { u, outcome } of checked) {
    if (!outcome.ok) {
      failed.push({ sourceId: u.sourceId, error: outcome.error });
      continue;
    }
    if (!outcome.file) {
      sources.push(toSummary(outcome.source));
      continue;
    }
    const updated = await record(teamId, outcome.source, outcome.file);
    if (!updated) {
      failed.push({ sourceId: u.sourceId, error: "Upload not found." });
      continue;
    }
    sources.push(toSummary(updated));
    ids.push(updated.id);
  }
  if (ids.length) after(() => Promise.all(ids.map((id) => ingestSource(teamId, id, agent))).then(() => undefined));
  return NextResponse.json({ sources, failed });
}
