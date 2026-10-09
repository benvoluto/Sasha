import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { planRun, startPlannedRun } from "@/lib/workflow/availability";
import { RunParams, type RunResponse } from "@/lib/workflow/contract";
import { executeGraph } from "@/lib/workflow/engine";
import { getDefaultWorkflowId, runView } from "@/lib/workflow/store";

export const runtime = "nodejs";
// The run continues in after(); the engine pauses itself before this limit.
export const maxDuration = 300;

const Body = z.strictObject({
  documentId: z.string().min(1).max(80),
  workflowId: z.string().min(1).max(120).optional(),
  version: z.number().int().min(0).optional(),
  params: RunParams.optional(),
});

/**
 * POST /api/workflow-runs/runs — the canvas's "Run on document". Body:
 * { documentId, workflowId?, version?, params? }; the team's default workflow's
 * newest version unless named. The same checks as starting from the document's
 * Workflows tab. 202 with the run; poll GET /runs/[runId]. Counts one
 * "workflow" call (429 when the allowance is used up).
 */
export async function POST(request: NextRequest) {
  const caller = await requireTeam(PERMISSIONS.workflowRun);
  if (caller instanceof NextResponse) return caller;
  enterModelContext(contextFor(caller));
  const parsed = Body.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const { documentId, version, params } = parsed.data;
  enterModelContext(contextFor(caller, { documentId: isUuid(documentId) ? documentId : null }));
  const doc = isUuid(documentId) ? await getDocument(caller.teamId, documentId) : null;
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const workflowId = parsed.data.workflowId ?? (await getDefaultWorkflowId(caller.teamId));
  if (!workflowId) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  const plan = await planRun(caller.teamId, doc, { workflowId, version, params });
  if (!plan.ok) return NextResponse.json({ error: plan.error, ...(plan.acknowledge ? { acknowledge: plan.acknowledge } : {}) }, { status: plan.status });
  const limited = await limitModelCall(caller, "workflow");
  if (limited) return limited;
  const run = await startPlannedRun(caller.teamId, doc, plan, caller);
  after(() => executeGraph(run));
  return NextResponse.json({ run: runView(run) } satisfies RunResponse, { status: 202 });
}
