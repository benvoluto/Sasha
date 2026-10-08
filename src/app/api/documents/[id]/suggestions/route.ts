import { NextResponse } from "next/server";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { SuggestionCreateRequest, type SuggestionListResponse, type SuggestionResponse } from "@/lib/suggestions/contract";
import { getSuggestionList } from "@/lib/suggestions/generate";
import { createUserSuggestion } from "@/lib/suggestions/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "Document not found." }, { status: 404 });

/** GET /api/documents/[id]/suggestions — every suggestion (all states) and whether the inputs changed since the last generation. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const list = await getSuggestionList(caller.teamId, id);
  if (!list) return notFound();
  return NextResponse.json(list satisfies SuggestionListResponse);
}

/**
 * POST /api/documents/[id]/suggestions — the person adds their own item.
 * 201 with the new row; 200 with the existing row when the label is already
 * suggested (restored to open if it had been dismissed).
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const parsed = SuggestionCreateRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const result = await createUserSuggestion(caller.teamId, caller.agent, id, parsed.data);
  if (!result) return notFound();
  return NextResponse.json({ suggestion: result.suggestion } satisfies SuggestionResponse, { status: result.created ? 201 : 200 });
}
