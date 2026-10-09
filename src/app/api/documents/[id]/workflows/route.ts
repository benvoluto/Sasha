import { after, NextResponse } from "next/server";
import { getType } from "@/catalog";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { availableWorkflows, planRun, startPlannedRun } from "@/lib/workflow/availability";
import { StartRunRequest, type DocumentWorkflowsResponse, type RunResponse } from "@/lib/workflow/contract";
import { executeGraph } from "@/lib/workflow/engine";
import { listDocumentRuns, runView } from "@/lib/workflow/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The run continues in after(); the engine pauses itself before this limit.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "Document not found." }, { status: 404 });

/** GET /api/documents/[id]/workflows — the workflows the document can run, and its run history. */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.workflowRead);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  const doc = isUuid(id) ? await getDocument(caller.teamId, id) : null;
  if (!doc) return notFound();
  const typeDef = (await getType(caller.teamId, doc.type_key))?.definition ?? null;
  const [available, runs] = await Promise.all([availableWorkflows(caller.teamId, doc, typeDef), listDocumentRuns(caller.teamId, doc.id)]);
  return NextResponse.json({ documentId: doc.id, typeKey: doc.type_key, available, runs } satisfies DocumentWorkflowsResponse);
}

/**
 * POST /api/documents/[id]/workflows — start a run. Body: StartRunRequest.
 * 202 with the run; it continues in the background (poll GET
 * /api/workflow-runs/runs/[runId]). 409 when the type's policy turns the
 * workflow off and the notice was not acknowledged. Counts one "workflow"
 * call (429 when the allowance is used up).
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.workflowRun);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  enterModelContext(contextFor(caller, { documentId: isUuid(id) ? id : null }));
  const doc = isUuid(id) ? await getDocument(caller.teamId, id) : null;
  if (!doc) return notFound();
  const parsed = StartRunRequest.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const plan = await planRun(caller.teamId, doc, parsed.data);
  if (!plan.ok) return NextResponse.json({ error: plan.error, ...(plan.acknowledge ? { acknowledge: plan.acknowledge } : {}) }, { status: plan.status });
  const limited = await limitModelCall(caller, "workflow");
  if (limited) return limited;
  const run = await startPlannedRun(caller.teamId, doc, plan, caller);
  after(() => executeGraph(run));
  return NextResponse.json({ run: runView(run) } satisfies RunResponse, { status: 202 });
}
