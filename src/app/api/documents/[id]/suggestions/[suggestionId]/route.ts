import { NextResponse } from "next/server";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { listDocumentSources } from "@/lib/sources/store";
import { SuggestionActionRequest, type SuggestionResponse } from "@/lib/suggestions/contract";
import { getSuggestion, setSuggestionState } from "@/lib/suggestions/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; suggestionId: string }> };

const notFound = () => NextResponse.json({ error: "Suggestion not found." }, { status: 404 });

/**
 * PATCH /api/documents/[id]/suggestions/[suggestionId] — add, dismiss or
 * restore. "add" with `source_id` (a source linked to this document) marks a
 * source/web suggestion covered by it; "add" on a data item marks it noted.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id, suggestionId } = await params;
  if (!isUuid(id) || !isUuid(suggestionId)) return notFound();
  const parsed = SuggestionActionRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const { action, source_id } = parsed.data;
  if (!(await getSuggestion(caller.teamId, id, suggestionId))) return notFound();
  if (source_id !== undefined) {
    if (action !== "add") return NextResponse.json({ error: "source_id goes only with the add action." }, { status: 400 });
    const linked = await listDocumentSources(caller.teamId, id);
    if (!linked?.some((s) => s.id === source_id)) return NextResponse.json({ error: "That source isn't linked to this document." }, { status: 400 });
  }
  const suggestion = await setSuggestionState(caller.teamId, id, suggestionId, action, source_id);
  if (!suggestion) return notFound();
  return NextResponse.json({ suggestion } satisfies SuggestionResponse);
}
