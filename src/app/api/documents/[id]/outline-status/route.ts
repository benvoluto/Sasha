import { NextResponse } from "next/server";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { limitedErrorResponse } from "@/lib/limits/http";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { OutlineStatusRequest, type OutlineStatusResponse } from "@/lib/sections/contract";
import { outlineStatus } from "@/lib/sections/outline-status";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/documents/[id]/outline-status — the living outline for the saved
 * document: which type sections are present and the status of their required
 * elements. Without Claude the element statuses are "unknown" (still 200).
 * 429 (RateLimitedBody) when the caller's "light" allowance is used up, or
 * when another instance checked the document moments ago.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  enterModelContext(contextFor(caller, { documentId: isUuid(id) ? id : null }));
  if (!isUuid(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const parsed = OutlineStatusRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  let status;
  try {
    status = await outlineStatus(caller.teamId, id, { force: parsed.data.force, agent: caller.agent, subject: caller });
  } catch (error) {
    const limited = limitedErrorResponse(error);
    if (limited) return limited;
    throw error;
  }
  if (!status) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json(status satisfies OutlineStatusResponse);
}
