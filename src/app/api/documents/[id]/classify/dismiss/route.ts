import { NextResponse } from "next/server";
import { ClassifyDismissRequest, type ClassifierViewResponse } from "@/lib/classifier/contract";
import { classifierView, dismissType } from "@/lib/classifier/store";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/documents/[id]/classify/dismiss — "Not now" on the classifier chip:
 * counts the type towards CLASSIFY_MAX_DISMISSALS and clears the last result → { view }.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const parsed = ClassifyDismissRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const doc = await dismissType(caller.teamId, id, parsed.data.key);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ view: classifierView(doc) } satisfies ClassifierViewResponse);
}
