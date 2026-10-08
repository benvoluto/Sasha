import { NextResponse } from "next/server";
import { listSectionMeta } from "@/lib/documents/section-store";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import type { SectionListResponse } from "@/lib/sections/contract";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/documents/[id]/sections — every stored section row (notes, status) for the document. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  const sections = isUuid(id) ? await listSectionMeta(caller.teamId, id) : null;
  if (!sections) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ sections } satisfies SectionListResponse);
}
