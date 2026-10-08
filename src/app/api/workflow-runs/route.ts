import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { can } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { modelForTier } from "@/lib/llm/tasks";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { builtInList, getDefaultWorkflowId, getWorkflow, listVersions, listWorkflows, ReadOnlyWorkflowError, saveWorkflow } from "@/lib/workflow/store";
import { WorkflowGraph } from "@/lib/workflow/types";
import { validateGraph } from "@/lib/workflow/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workflow-runs?workflowId=<id>&version=<n> — one version of a
 * workflow (the team's default workflow's newest when not named), plus what
 * the canvas needs alongside it: the team's workflows, the built-ins
 * (read-only), this one's versions, and the default.
 */
export async function GET(request: NextRequest) {
  const caller = await requireTeam(PERMISSIONS.workflowRead);
  if (caller instanceof NextResponse) return caller;
  const params = request.nextUrl.searchParams;
  const workflowId = params.get("workflowId") || params.get("workflow") || (await getDefaultWorkflowId(caller.teamId));
  if (!workflowId) return NextResponse.json({ error: "No workflows yet." }, { status: 404 });
  const versionParam = params.get("version");
  const version = versionParam === null || versionParam === "" ? undefined : Number(versionParam);
  if (version !== undefined && !Number.isInteger(version)) return NextResponse.json({ error: "version must be a whole number" }, { status: 400 });
  const shown = await getWorkflow(caller.teamId, workflowId, version);
  if (!shown) return NextResponse.json({ error: version === undefined ? "Workflow not found." : `Version ${version} not found.` }, { status: 404 });
  const [workflows, versions, defaultWorkflowId] = await Promise.all([listWorkflows(caller.teamId), listVersions(caller.teamId, workflowId), getDefaultWorkflowId(caller.teamId)]);
  return NextResponse.json({
    ...shown,
    workflows,
    builtIns: builtInList(),
    versions,
    defaultWorkflowId,
    defaults: defaultWorkflowGraph(),
    // May edit team workflows (and copy built-ins); `readOnly` says whether this one can be saved over.
    canEdit: can(caller, PERMISSIONS.workflowEdit),
    canRun: can(caller, PERMISSIONS.workflowRun),
    providers: {
      anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, defaultModel: modelForTier("mid") },
      gateway: { configured: !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) },
    },
    persisted: !!process.env.POSTGRES_URL,
  });
}

const PutBody = z.object({
  workflowId: z.string().min(1).max(120),
  graph: z.unknown(),
  note: z.string().max(500).optional(),
});

/** PUT /api/workflow-runs — save a new version of a team workflow. Body: { workflowId, graph, note }. Rejects graphs with errors and built-ins (copy them first). */
export async function PUT(request: NextRequest) {
  const caller = await requireTeam(PERMISSIONS.workflowEdit);
  if (caller instanceof NextResponse) return caller;
  const body = PutBody.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return NextResponse.json({ error: "workflowId and graph are required" }, { status: 400 });
  const parsed = WorkflowGraph.safeParse(body.data.graph);
  if (!parsed.success) return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const errors = validateGraph(parsed.data).filter((i) => i.severity === "error");
  if (errors.length) return NextResponse.json({ error: errors.map((e) => e.message).join("; "), issues: errors }, { status: 400 });
  const existing = await getWorkflow(caller.teamId, body.data.workflowId);
  if (!existing) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  try {
    return NextResponse.json(await saveWorkflow(caller.teamId, existing.workflow_id, parsed.data, body.data.note ?? "", caller));
  } catch (e) {
    if (e instanceof ReadOnlyWorkflowError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
