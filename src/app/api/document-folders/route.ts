import { NextResponse } from "next/server";
import { createDocFolder, listDocFolders } from "@/lib/documents/folder-store";
import { CreateDocFolderBody, docFolderNameError, type DocFolderListResponse, type DocFolderResponse } from "@/lib/documents/folders-contract";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

/** GET /api/document-folders — the team's document folders, by name, with document counts. */
export async function GET() {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const body: DocFolderListResponse = { folders: await listDocFolders(caller.teamId) };
  return NextResponse.json(body);
}

/** POST /api/document-folders — create a folder. 409 when the team already has that name (ignoring case). */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = CreateDocFolderBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: docFolderNameError(parsed.error) }, { status: 400 });
  const result = await createDocFolder(caller.teamId, caller.agent, parsed.data.name);
  if (!result.ok) return NextResponse.json({ error: "A folder with that name already exists." }, { status: 409 });
  const body: DocFolderResponse = { folder: result.folder };
  return NextResponse.json(body, { status: 201 });
}
