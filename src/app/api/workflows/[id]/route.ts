import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { renameWorkflow } from "@/lib/workflow/store";

export const runtime = "nodejs";

/** PATCH /api/workflows/[id] — rename one of the team's workflows (built-ins can't be renamed). Body: { name }. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireTeam(PERMISSIONS.workflowEdit);
  if (caller instanceof NextResponse) return caller;
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A name is required." }, { status: 400 });
  const { id } = await params;
  if (!(await renameWorkflow(caller.teamId, id, parsed.data.name, caller))) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
