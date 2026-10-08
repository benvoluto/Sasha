import { NextResponse } from "next/server";
import { invalidDefinition, issueLines } from "@/catalog/api";
import { saveOutlineAsType } from "@/catalog/index";
import { toTypeSummary } from "@/catalog/schema";
import { getDocument } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { SaveOutlineAsTypeRequest, type SaveOutlineAsTypeResponse } from "@/lib/sections/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/document-types/from-document — "Save outline as type": a team type
 * whose sections are the document's top-level headings. The response maps each
 * heading's sectionId to its section key so the editor can stamp them.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = SaveOutlineAsTypeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issues = issueLines(parsed.error);
    return NextResponse.json({ error: `Invalid request: ${issues[0]}`, issues }, { status: 400 });
  }
  const { documentId, title, key, family, summary } = parsed.data;
  const document = await getDocument(caller.teamId, documentId);
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const result = await saveOutlineAsType(caller.teamId, caller.agent, { document, title, key, family, summary });
  if (!result.ok) {
    if (result.reason === "clash") return NextResponse.json({ error: result.message }, { status: 409 });
    if (result.reason === "invalid") return invalidDefinition(result.issues ?? [result.message]);
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  const body: SaveOutlineAsTypeResponse = { type: toTypeSummary(result.entry), specKeys: result.specKeys };
  return NextResponse.json(body, { status: 201 });
}
