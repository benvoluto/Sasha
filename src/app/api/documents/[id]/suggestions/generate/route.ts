import { NextResponse } from "next/server";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { SuggestionGenerateRequest, type SuggestionGenerateResponse } from "@/lib/suggestions/contract";
import { generateSuggestions } from "@/lib/suggestions/generate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/documents/[id]/suggestions/generate — regenerate the document's
 * suggestions. `ran: false` (inputs unchanged, the per-minute gate, Claude not
 * configured, or a failed model call with `error`) is a normal 200.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const parsed = SuggestionGenerateRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const result = await generateSuggestions(caller.teamId, id, { force: parsed.data.force, agent: caller.agent });
  if (!result) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json(result satisfies SuggestionGenerateResponse);
}
