import { NextResponse } from "next/server";
import { DataLinkRequest, type DocumentDataResponse } from "@/lib/data/contract";
import { linkTable, listDocumentTables } from "@/lib/data/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const docNotFound = () => NextResponse.json({ error: "Document not found." }, { status: 404 });

/** GET /api/documents/[id]/data — the document's linked tables (any status), oldest link first. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const tables = await listDocumentTables(caller.teamId, (await params).id);
  if (!tables) return docNotFound();
  return NextResponse.json({ tables } satisfies DocumentDataResponse);
}

/** POST /api/documents/[id]/data — link a table of the team to the document (idempotent). */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = DataLinkRequest.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "Choose a table to add." }, { status: 400 });
  const { id } = await params;
  const result = await linkTable(caller.teamId, caller.agent, id, parsed.data.table_id);
  if (result === "document_not_found") return docNotFound();
  if (result === "table_not_found") return NextResponse.json({ error: "Table not found." }, { status: 404 });
  const table = (await listDocumentTables(caller.teamId, id))?.find((t) => t.id === parsed.data.table_id);
  // Removed between the link and the read (the table's source was deleted).
  if (!table) return NextResponse.json({ error: "Table not found." }, { status: 404 });
  return NextResponse.json({ table });
}
