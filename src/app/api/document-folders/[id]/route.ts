import { NextResponse } from "next/server";
import { deleteDocFolder, renameDocFolder } from "@/lib/documents/folder-store";
import { UpdateDocFolderBody, docFolderNameError, type DeleteDocFolderResponse, type DocFolderResponse } from "@/lib/documents/folders-contract";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/document-folders/[id] — rename. 409 when another folder of the team has that name. */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = UpdateDocFolderBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: docFolderNameError(parsed.error) }, { status: 400 });
  const result = await renameDocFolder(caller.teamId, (await params).id, parsed.data.name);
  if (!result.ok && result.reason === "not_found") return NextResponse.json({ error: "Folder not found." }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: "A folder with that name already exists." }, { status: 409 });
  const body: DocFolderResponse = { folder: result.folder };
  return NextResponse.json(body);
}

/** DELETE /api/document-folders/[id] — delete; its documents (archived too) move to the top level. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const result = await deleteDocFolder(caller.teamId, (await params).id);
  if (!result) return NextResponse.json({ error: "Folder not found." }, { status: 404 });
  const body: DeleteDocFolderResponse = { deleted: true, moved: result.moved };
  return NextResponse.json(body);
}
