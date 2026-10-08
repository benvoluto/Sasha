import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { unlinkSource } from "@/lib/sources/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

/** DELETE /api/documents/[id]/sources/[sourceId] — unlink; the source stays in the library. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const { id, sourceId } = await params;
  const ok = await unlinkSource(caller.teamId, id, sourceId);
  if (!ok) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
