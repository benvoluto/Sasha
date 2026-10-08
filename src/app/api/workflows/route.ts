import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { builtInList, createWorkflow, getDefaultWorkflowId, getWorkflow, listWorkflows } from "@/lib/workflow/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workflows — the team's workflows, the built-ins, and which one the canvas opens first. */
export async function GET() {
  const caller = await requireTeam(PERMISSIONS.workflowRead);
  if (caller instanceof NextResponse) return caller;
  const [workflows, defaultWorkflowId] = await Promise.all([listWorkflows(caller.teamId), getDefaultWorkflowId(caller.teamId)]);
  return NextResponse.json({ workflows, builtIns: builtInList(), defaultWorkflowId });
}

const Create = z.object({
  name: z.string().trim().min(1).max(80),
  /** Start from a copy of this workflow's newest version: a built-in ("builtin:<key>") or one of the team's. The starting graph when omitted. */
  basedOn: z.string().min(1).max(120).optional(),
});

/** POST /api/workflows — create a team workflow. Body: { name, basedOn? }. */
export async function POST(request: NextRequest) {
  const caller = await requireTeam(PERMISSIONS.workflowEdit);
  if (caller instanceof NextResponse) return caller;
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A name is required." }, { status: 400 });
  const { name, basedOn } = parsed.data;
  const source = basedOn ? await getWorkflow(caller.teamId, basedOn) : null;
  if (basedOn && !source) return NextResponse.json({ error: "The workflow to copy was not found." }, { status: 404 });
  return NextResponse.json({ workflow: await createWorkflow(caller.teamId, name, source?.graph ?? defaultWorkflowGraph(), caller, source?.workflow_id) }, { status: 201 });
}
