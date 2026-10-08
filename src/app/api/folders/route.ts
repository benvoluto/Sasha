import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { createFolder, listFolders } from "@/lib/sources/store";

export const dynamic = "force-dynamic";

/** GET /api/folders — every folder in the team's library (the client builds the tree). */
export async function GET() {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const folders = await listFolders(caller.teamId);
  return NextResponse.json({ folders });
}

const PostBody = z.object({
  name: z.string().trim().min(1).max(200),
  parent_id: z.string().uuid().nullable().optional(),
});

/** POST /api/folders — create a folder, at the root or inside parent_id. */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give the folder a name." }, { status: 400 });
  const result = await createFolder(caller.teamId, caller.agent, parsed.data);
  if (!result.ok) return NextResponse.json({ error: "Parent folder not found." }, { status: 404 });
  return NextResponse.json({ folder: result.folder }, { status: 201 });
}
