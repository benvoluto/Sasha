import { NextResponse } from "next/server";
import { unlinkTable } from "@/lib/data/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; tableId: string }> };

/** DELETE /api/documents/[id]/data/[tableId] — remove the table from the document (the table stays in the library). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id, tableId } = await params;
  if (!(await unlinkTable(caller.teamId, id, tableId, caller.agent))) return NextResponse.json({ error: "That table isn't linked to this document." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
