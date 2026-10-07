import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { RUN_PERMISSION, getDefaultWorkflowId, getWorkflow, listVersions, listWorkflows, saveWorkflow } from "@/lib/workflow/store";
import { GEMINI_MODEL } from "@/lib/gemini-model";
import { defaultWorkflowGraph } from "@/lib/workflow/default-graph";
import { WorkflowGraph } from "@/lib/workflow/types";
import { validateGraph } from "@/lib/workflow/validate";

export const runtime = "nodejs";

/**
 * GET /api/workflow-runs?workflow=<id>&version=<n> — one version of a
 * workflow (the default workflow's newest when not named), plus what the editor
 * needs alongside it: every workflow, this one's versions, and the default.
 */
export async function GET(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const workflowId = params.get("workflow") || (await getDefaultWorkflowId());
  const versionParam = params.get("version");
  const version = versionParam === null || versionParam === "" ? undefined : Number(versionParam);
  if (version !== undefined && !Number.isInteger(version)) return NextResponse.json({ error: "version must be a whole number" }, { status: 400 });
  const shown = await getWorkflow(workflowId, version);
  if (!shown) return NextResponse.json({ error: version === undefined ? "workflow not found" : `version ${version} not found` }, { status: 404 });
  const [workflows, versions, defaultWorkflowId] = await Promise.all([listWorkflows(), listVersions(workflowId), getDefaultWorkflowId()]);
  return NextResponse.json({
    ...shown,
    workflows,
    versions,
    defaultWorkflowId,
    defaults: defaultWorkflowGraph(),
    canEdit: can(caller, "workflow:write"),
    canRun: can(caller, RUN_PERMISSION),
    providers: {
      gemini: { configured: !!process.env.GEMINI_API_KEY, defaultModel: GEMINI_MODEL },
      gateway: { configured: !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) },
    },
    persisted: !!process.env.POSTGRES_URL,
  });
}

/** PUT /api/workflow-runs — save a new version of a workflow. Body: { workflowId, definition, note }. Rejects graphs with errors. */
export async function PUT(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, "workflow:write")) return NextResponse.json({ error: "permission denied: requires 'workflow:write'" }, { status: 403 });

  let body: { workflowId?: unknown; definition?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = WorkflowGraph.safeParse(body.definition);
  if (!parsed.success) return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const errors = validateGraph(parsed.data).filter((i) => i.severity === "error");
  if (errors.length) return NextResponse.json({ error: errors.map((e) => e.message).join("; "), issues: errors }, { status: 400 });
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";
  const workflowId = typeof body.workflowId === "string" && body.workflowId ? body.workflowId : await getDefaultWorkflowId();
  if (!(await getWorkflow(workflowId))) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  return NextResponse.json(await saveWorkflow(workflowId, parsed.data, note, caller));
}
