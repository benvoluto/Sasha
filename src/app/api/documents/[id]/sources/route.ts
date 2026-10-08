import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { linkSource, listDocumentSources } from "@/lib/sources/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/documents/[id]/sources — the sources linked to the document, oldest link first, each with its role. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const sources = await listDocumentSources(caller.teamId, (await params).id);
  if (!sources) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ sources });
}

const PostBody = z.object({
  source_id: z.string().uuid(),
  role: z.string().trim().max(100).nullable().optional(),
});

/** POST /api/documents/[id]/sources — link a library source to the document (idempotent). */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose a source to link." }, { status: 400 });
  const result = await linkSource(caller.teamId, caller.agent, (await params).id, parsed.data.source_id, parsed.data.role || null);
  if (result === "document_not_found") return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (result === "source_not_found") return NextResponse.json({ error: "Source not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
