import { after, NextRequest, NextResponse } from "next/server";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { executeGraph } from "@/lib/workflow/engine";
import { RUN_PERMISSION, activeWorkflow, createRun, getDefaultWorkflowId, getWorkflow, latestRun } from "@/lib/workflow/store";

export const runtime = "nodejs";
// The run continues in after(); the engine pauses itself before this limit.
export const maxDuration = 300;

/**
 * POST /api/workflow-runs/runs — run a workflow on an upload's source documents.
 * Body: { groupId, workflowId?, version? } — the default workflow's newest
 * version unless named. Returns the run immediately; poll GET /runs/[runId].
 */
export async function POST(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, RUN_PERMISSION)) return NextResponse.json({ error: `permission denied: requires '${RUN_PERMISSION}'` }, { status: 403 });

  let groupId = "";
  let workflowId: string | undefined;
  let version: number | undefined;
  try {
    const body = await request.json();
    if (typeof body?.groupId === "string") groupId = body.groupId.trim();
    if (typeof body?.workflowId === "string" && body.workflowId) workflowId = body.workflowId;
    if (Number.isInteger(body?.version)) version = body.version;
  } catch {
    // handled below
  }
  if (!groupId) return NextResponse.json({ error: "groupId is required" }, { status: 400 });

  // A named workflow and version, or the default workflow's newest.
  const workflow = workflowId || version !== undefined ? await getWorkflow(workflowId ?? (await getDefaultWorkflowId()), version) : await activeWorkflow();
  if (!workflow) return NextResponse.json({ error: "workflow or version not found" }, { status: 404 });
  const run = await createRun(groupId, workflow, caller);
  after(() => executeGraph(run));
  return NextResponse.json({ run }, { status: 202 });
}

/** GET /api/workflow-runs/runs?groupId=[&brief=1] — the latest run on an upload group. */
export async function GET(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const groupId = request.nextUrl.searchParams.get("groupId");
  if (!groupId) return NextResponse.json({ error: "groupId is required" }, { status: 400 });
  const run = await latestRun(groupId);
  // ?brief=1: just where the run stands, for links (the full run carries every node's output).
  if (request.nextUrl.searchParams.get("brief") && run) {
    const { id, status, workflow_id, workflow_name, workflow_version, created_at, updated_at } = run;
    return NextResponse.json({ run: { id, status, workflow_id, workflow_name, workflow_version, created_at, updated_at } });
  }
  return NextResponse.json({ run });
}
