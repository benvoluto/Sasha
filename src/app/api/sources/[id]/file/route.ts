import { NextResponse } from "next/server";
import { blobAuthHeaders, isOwnBlobUrl } from "@/lib/blob-host";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { getSource } from "@/lib/sources/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** RFC 6266 filename parameters: an ASCII fallback plus the UTF-8 original. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/sources/[id]/file[?download=1] — the source's file, after the team
 * check. The client never sees the blob URL. A link source with no stored copy
 * redirects to the original page.
 */
export async function GET(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const source = await getSource(caller.teamId, (await params).id);
  if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });

  if (!source.blob_url) {
    if (source.kind === "url" && source.url) return NextResponse.redirect(source.url, 302);
    return NextResponse.json({ error: "This source has no file." }, { status: 404 });
  }
  // Only ever read from our own store, whatever the row says.
  if (!isOwnBlobUrl(source.blob_url)) return NextResponse.json({ error: "This source has no file." }, { status: 404 });

  const upstream = await fetch(source.blob_url, { headers: blobAuthHeaders(source.blob_url), cache: "no-store" });
  if (!upstream.ok || !upstream.body) {
    console.error(`[Sources] file fetch for ${source.id} returned ${upstream.status}`);
    return NextResponse.json({ error: "The file couldn't be loaded." }, { status: 502 });
  }
  const download = new URL(req.url).searchParams.get("download") === "1";
  const contentType = source.mime || "application/octet-stream";
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": disposition(download ? "attachment" : "inline", source.filename || "file"),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  // Served from our origin, so keep an uploaded file from running anything. (A
  // sandboxing policy stops Chrome's PDF viewer, and a PDF can't script our page.)
  if (contentType !== "application/pdf") headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}
