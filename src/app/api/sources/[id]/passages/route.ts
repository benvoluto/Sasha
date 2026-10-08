import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { listPassages } from "@/lib/sources/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sources/[id]/passages — the source's citable passages, in order. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const passages = await listPassages(caller.teamId, (await params).id);
  if (!passages) return NextResponse.json({ error: "Source not found." }, { status: 404 });
  return NextResponse.json({ passages });
}
