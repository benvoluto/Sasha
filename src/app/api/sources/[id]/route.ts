import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { deleteSourceBlobs } from "@/lib/sources/blobs";
import { deleteSource, getSource, toDetail, toSummary, updateSource } from "@/lib/sources/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sources/[id] — the source with its extracted text and linked document ids. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const source = await getSource(caller.teamId, (await params).id);
  if (!source) return NextResponse.json({ error: "Source not found." }, { status: 404 });
  return NextResponse.json({ source: toDetail(source) });
}

const PatchBody = z
  .object({
    title: z.string().trim().max(300).nullable().optional(),
    /** null moves the source to the library root. */
    folder_id: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.title !== undefined || b.folder_id !== undefined);

/** PATCH /api/sources/[id] — rename or move. */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid changes." }, { status: 400 });
  const { title, folder_id } = parsed.data;
  const result = await updateSource(caller.teamId, (await params).id, { title: title === "" ? null : title, folder_id });
  if (!result.ok) return NextResponse.json({ error: result.reason === "folder_not_found" ? "Folder not found." : "Source not found." }, { status: 404 });
  return NextResponse.json({ source: toSummary(result.source) });
}

/**
 * DELETE /api/sources/[id] — removes the source, its links and passages, and
 * every file it stored (not only the current one: an earlier copy of a re-read
 * PDF link, or an upload that never finished, would otherwise stay public).
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const deleted = await deleteSource(caller.teamId, (await params).id);
  if (!deleted) return NextResponse.json({ error: "Source not found." }, { status: 404 });
  await deleteSourceBlobs(caller.teamId, deleted.id, [deleted.blob_url]);
  return NextResponse.json({ ok: true });
}
