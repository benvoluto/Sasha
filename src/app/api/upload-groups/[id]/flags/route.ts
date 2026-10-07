import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { fetchGroupMetadata } from "@/lib/ontology/group-metadata";
import { setArchived, setSummaryNote } from "@/lib/ontology/case-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/upload-groups/[id]/flags
 *
 * Body may carry either or both:
 *   { archived: boolean }            archive / restore the document
 *   { summaryNote: string | null }   save or clear the person's own summary
 *
 * Separate from the record itself because these are the only two fields a
 * person edits directly — everything else is derived from the uploaded files.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { archived?: unknown; summaryNote?: unknown; basedOn?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const wantsArchive = typeof body.archived === "boolean";
  const wantsNote = typeof body.summaryNote === "string" || body.summaryNote === null;
  if (!wantsArchive && !wantsNote) {
    return NextResponse.json({ error: "archived (boolean) or summaryNote (string|null) is required" }, { status: 400 });
  }

  if (!(await fetchGroupMetadata(id))) {
    return NextResponse.json({ error: "document not found", id }, { status: 404 });
  }

  try {
    // Sequential, not concurrent: both are read-modify-write against the same
    // metadata blob, so running them in parallel would lose one of the two.
    if (wantsArchive) {
      await setArchived(id, body.archived as boolean, auth.agent);
    }
    if (wantsNote) {
      await setSummaryNote(id, body.summaryNote as string | null, {
        by: auth.agent,
        basedOn: typeof body.basedOn === "string" ? body.basedOn : undefined,
      });
    }
  } catch (error) {
    console.error(`[caseFlags] PATCH failed for ${id}:`, error);
    return NextResponse.json({ error: "could not save the change" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
