import { NextResponse } from "next/server";
import { putE2eBlob, withRandomSuffix } from "@/lib/e2e/blob-store";
import { e2eStubBlob } from "@/lib/e2e/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Biggest body the stand-in store accepts; the smoke fixtures are a few KB. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * PUT /api/e2e/blob?pathname=… — the stand-in for Vercel Blob's upload API in
 * e2e runs (SASHA_E2E_STUB_BLOB=1, never production; see src/lib/e2e/mode.ts).
 * The Playwright upload spec intercepts the browser's @vercel/blob/client PUT
 * and forwards the bytes here; the reply has the Blob API's shape, so the
 * client returns it as the stored blob. 404 whenever the stub is off.
 */
export async function PUT(req: Request) {
  if (!e2eStubBlob()) return new NextResponse(null, { status: 404 });
  const pathname = new URL(req.url).searchParams.get("pathname")?.replace(/^\/+/, "") ?? "";
  if (!pathname || pathname.length > 1000 || pathname.split("/").includes("..")) {
    return NextResponse.json({ error: "A pathname is required." }, { status: 400 });
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: "Too large for the e2e store." }, { status: 413 });
  const contentType = req.headers.get("x-content-type") || req.headers.get("content-type") || "application/octet-stream";
  const stored = putE2eBlob(withRandomSuffix(pathname), bytes, contentType);
  const name = stored.pathname.split("/").pop() ?? stored.pathname;
  return NextResponse.json({
    url: stored.url,
    downloadUrl: `${stored.url}?download=1`,
    pathname: stored.pathname,
    contentType: stored.contentType,
    contentDisposition: `attachment; filename="${name.replace(/"/g, "")}"`,
  });
}
