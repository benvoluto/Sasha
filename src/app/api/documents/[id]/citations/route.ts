import { NextResponse } from "next/server";
import type { CitationsResponse } from "@/lib/citations/contract";
import { documentCitations } from "@/lib/citations/references";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/documents/[id]/citations — the stored document's sources cited,
 * numbered and resolved, with the ones that no longer hold (source unlinked or
 * deleted, passage gone after a re-read). The editor's citation lint and
 * hover read it. No model call.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  const doc = isUuid(id) ? await getDocument(caller.teamId, id) : null;
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const body: CitationsResponse = await documentCitations(caller.teamId, doc.id, doc.content_json);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
