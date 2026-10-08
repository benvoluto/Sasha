import { NextResponse } from "next/server";
import { TableListQuery, type TableListResponse } from "@/lib/data/contract";
import { listTables } from "@/lib/data/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/data/tables?source_id=&document_id=&for_document=&status=active,hidden&q=
 * The team's tables, newest first (at most 200). Filters combine.
 */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const parsed = TableListQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Those table filters aren't valid." }, { status: 400 });
  const q = parsed.data;
  const tables = await listTables(caller.teamId, { sourceId: q.source_id, documentId: q.document_id, forDocument: q.for_document, status: q.status, query: q.q });
  return NextResponse.json({ tables } satisfies TableListResponse);
}
