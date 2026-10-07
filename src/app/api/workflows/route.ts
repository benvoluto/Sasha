import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { createWorkflow, getDefaultWorkflowId, getWorkflow, listWorkflows } from "@/lib/workflow/store";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";

export const runtime = "nodejs";

/** GET /api/workflows — every workflow and which one is the default (for run and upload pickers). */
export async function GET() {
  if (!(await authFromClerk())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [workflows, defaultWorkflowId] = await Promise.all([listWorkflows(), getDefaultWorkflowId()]);
  return NextResponse.json({ workflows, defaultWorkflowId });
}

const Create = z.object({
  name: z.string().trim().min(1).max(80),
  /** Start from a copy of this workflow's version; the built-in default when omitted. */
  from: z.object({ workflowId: z.string().min(1), version: z.number().int().min(0).optional() }).optional(),
});

/** POST /api/workflows — create a named workflow. Body: { name, from? }. */
export async function POST(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, "workflow:write")) return NextResponse.json({ error: "permission denied: requires 'workflow:write'" }, { status: 403 });
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "a name is required" }, { status: 400 });
  const { name, from } = parsed.data;
  const source = from ? await getWorkflow(from.workflowId, from.version) : null;
  if (from && !source) return NextResponse.json({ error: "the workflow to copy was not found" }, { status: 404 });
  return NextResponse.json({ workflow: await createWorkflow(name, source?.definition ?? defaultWorkflowGraph(), caller) }, { status: 201 });
}
