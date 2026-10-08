import { NextResponse } from "next/server";
import { getSectionMeta, putSectionNotes } from "@/lib/documents/section-store";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { SectionId, SectionNotesPut, type SectionResponse } from "@/lib/sections/contract";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sectionId: string }> };

const notFound = () => NextResponse.json({ error: "Document not found." }, { status: 404 });

/** GET /api/documents/[id]/sections/[sectionId] — the section's notes and status (a blank row when it has none). */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const { id, sectionId } = await params;
  if (!isUuid(id) || !SectionId.safeParse(sectionId).success) return notFound();
  const section = await getSectionMeta(caller.teamId, id, sectionId);
  if (!section) return notFound();
  return NextResponse.json({ section } satisfies SectionResponse);
}

/** PUT /api/documents/[id]/sections/[sectionId] — save the section's notes (kept out of the document autosave). */
export async function PUT(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id, sectionId } = await params;
  if (!isUuid(id) || !SectionId.safeParse(sectionId).success) return notFound();
  const parsed = SectionNotesPut.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid notes." }, { status: 400 });
  const section = await putSectionNotes(caller.teamId, id, sectionId, parsed.data);
  if (!section) return notFound();
  return NextResponse.json({ section } satisfies SectionResponse);
}
