import { NextResponse } from "next/server";
import { z } from "zod";
import { listVersions, snapshotVersion } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/documents/[id]/versions — saved snapshots, newest first. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  return NextResponse.json({ versions: await listVersions(caller.teamId, (await params).id) });
}

const Body = z.object({ reason: z.string().min(1).max(200) });

/** POST /api/documents/[id]/versions — snapshot the saved document before a large change. */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give a reason for the snapshot." }, { status: 400 });
  const version = await snapshotVersion(caller.teamId, (await params).id, caller.agent, parsed.data.reason);
  if (!version) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ version }, { status: 201 });
}
