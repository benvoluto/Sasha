import { NextResponse } from "next/server";
import { z } from "zod";
import { getDocFolder } from "@/lib/documents/folder-store";
import { DocFolderIdField } from "@/lib/documents/folders-contract";
import { deleteDocument, getDocument, updateDocument, type DocumentPatch } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/documents/[id] */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const doc = await getDocument(caller.teamId, (await params).id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ document: doc });
}

const PatchBody = z.object({
  title: z.string().max(300).optional(),
  type_key: z.string().max(100).nullable().optional(),
  content_json: z.object({ type: z.literal("doc") }).passthrough().optional(),
  notes: z.string().max(200_000).optional(),
  archived: z.boolean().optional(),
  /** Move to a document folder of the team, or null for the top level. Not an edit (updated_at stays). */
  doc_folder_id: DocFolderIdField.optional(),
  /** The `updated_at` the client last saw; a newer stored version is a conflict. */
  base_updated_at: z.string().optional(),
  /** Save even if someone else changed the document (the person chose to overwrite). */
  force: z.boolean().optional(),
});

/** PATCH /api/documents/[id] — save changes. Returns 409 with the current document on a conflict. */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid changes." }, { status: 400 });
  const { base_updated_at, force, ...patch } = parsed.data;
  if (patch.doc_folder_id) {
    if (!(await getDocFolder(caller.teamId, patch.doc_folder_id))) return NextResponse.json({ error: "Unknown folder." }, { status: 400 });
    patch.doc_folder_id = patch.doc_folder_id.toLowerCase();
  }
  const result = await updateDocument(caller.teamId, (await params).id, caller.agent, patch as DocumentPatch, force ? undefined : base_updated_at);
  if (!result.ok && result.reason === "not_found") return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: "This document was changed by someone else.", document: result.doc }, { status: 409 });
  return NextResponse.json({ document: result.doc });
}

/** DELETE /api/documents/[id] */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const ok = await deleteDocument(caller.teamId, (await params).id);
  if (!ok) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
