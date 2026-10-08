import { NextResponse } from "next/server";
import { classifyDocument } from "@/lib/classifier/classify";
import { ClassifyRequest, type ClassifierViewResponse } from "@/lib/classifier/contract";
import { classifierView } from "@/lib/classifier/store";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "Document not found." }, { status: 404 });

/** GET /api/documents/[id]/classify — the classifier view (last result, dismissals) → { view }. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const doc = await getDocument(caller.teamId, (await params).id);
  if (!doc) return notFound();
  return NextResponse.json({ view: classifierView(doc) } satisfies ClassifierViewResponse);
}

/**
 * POST /api/documents/[id]/classify — run the document-type classifier over the
 * saved notes and text (src/lib/classifier/classify.ts). 200 { ran, view } or
 * { ran: false, reason, view }; 429 { error, retryAfterMs, view } inside the
 * 2-minute window.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const parsed = ClassifyRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const outcome = await classifyDocument(caller.teamId, id, { trigger: parsed.data.trigger, agent: caller.agent });
  if (!outcome) return notFound();
  if (outcome.status === 429) {
    return NextResponse.json(outcome.body, { status: 429, headers: { "Retry-After": String(Math.ceil(outcome.body.retryAfterMs / 1000)) } });
  }
  return NextResponse.json(outcome.body);
}
