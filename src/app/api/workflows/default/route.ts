import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { setDefaultWorkflowId } from "@/lib/workflow/store";

export const runtime = "nodejs";

/** PUT /api/workflows/default — choose the workflow the team's canvas opens first (a team workflow or a built-in). Body: { workflowId }. */
export async function PUT(request: NextRequest) {
  const caller = await requireTeam(PERMISSIONS.workflowEdit);
  if (caller instanceof NextResponse) return caller;
  const parsed = z.object({ workflowId: z.string().min(1) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
  if (!(await setDefaultWorkflowId(caller.teamId, parsed.data.workflowId, caller))) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  return NextResponse.json({ defaultWorkflowId: parsed.data.workflowId });
}
