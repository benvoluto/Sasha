import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { setDefaultWorkflowId } from "@/lib/workflow/store";

export const runtime = "nodejs";

/** PUT /api/workflows/default — choose the workflow that runs unless someone picks another. Body: { workflowId }. */
export async function PUT(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, "workflow:write")) return NextResponse.json({ error: "permission denied: requires 'workflow:write'" }, { status: 403 });
  const parsed = z.object({ workflowId: z.string().min(1) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
  if (!(await setDefaultWorkflowId(parsed.data.workflowId, caller))) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  return NextResponse.json({ defaultWorkflowId: parsed.data.workflowId });
}
