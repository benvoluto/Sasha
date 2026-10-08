import { NextResponse } from "next/server";
import { getDocFolder } from "@/lib/documents/folder-store";
import { BulkDocumentsBody, type BulkDocumentsResponse } from "@/lib/documents/folders-contract";
import { bulkDocuments } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

/**
 * POST /api/documents/bulk — archive, restore, delete or move (to a folder, or
 * null for the top level) several documents. Ids outside the caller's team
 * come back in `missing` and are left alone.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = BulkDocumentsBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const body = parsed.data;
  if (body.action === "move" && body.doc_folder_id !== null && !(await getDocFolder(caller.teamId, body.doc_folder_id))) {
    return NextResponse.json({ error: "Unknown folder." }, { status: 400 });
  }
  const { done, missing } = await bulkDocuments(caller.teamId, caller.agent, body);
  const result: BulkDocumentsResponse = { action: body.action, done, missing };
  return NextResponse.json(result);
}
