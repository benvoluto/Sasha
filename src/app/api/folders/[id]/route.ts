import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { deleteFolder, updateFolder } from "@/lib/sources/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    /** null moves the folder to the root. */
    parent_id: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.parent_id !== undefined);

/** PATCH /api/folders/[id] — rename and/or move. Moving a folder into itself or a subfolder is refused (400). */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid changes." }, { status: 400 });
  const result = await updateFolder(caller.teamId, (await params).id, parsed.data);
  if (result.ok) return NextResponse.json({ folder: result.folder });
  if (result.reason === "cycle") return NextResponse.json({ error: "A folder can't be moved inside itself." }, { status: 400 });
  if (result.reason === "parent_not_found") return NextResponse.json({ error: "Destination folder not found." }, { status: 404 });
  return NextResponse.json({ error: "Folder not found." }, { status: 404 });
}

/** DELETE /api/folders/[id] — deletes the folder and its subfolders; their sources move to the library root. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const ok = await deleteFolder(caller.teamId, (await params).id);
  if (!ok) return NextResponse.json({ error: "Folder not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
