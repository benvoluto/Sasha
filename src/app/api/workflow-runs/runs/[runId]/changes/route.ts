import { NextRequest, NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { ChangeResultRequest, type RunResponse } from "@/lib/workflow/contract";
import { auditRun, getRun, proposedChanges, recordChangeResult, runView } from "@/lib/workflow/store";

export const runtime = "nodejs";

/**
 * POST /api/workflow-runs/runs/[runId]/changes — record what happened to a
 * change the run proposed (the open editor applied it, the person discarded
 * it, or it was skipped). Body: ChangeResultRequest. Returns the run.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await requireTeam(PERMISSIONS.workflowRun);
  if (caller instanceof NextResponse) return caller;
  const run = await getRun(caller.teamId, (await params).runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  const parsed = ChangeResultRequest.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const { changeId, result, detail } = parsed.data;
  if (!proposedChanges(run).some((c) => c.id === changeId)) return NextResponse.json({ error: "The run proposed no such change." }, { status: 400 });
  const updated = await recordChangeResult(caller.teamId, run.id, changeId, { result, by: caller.agent, at: new Date().toISOString(), detail });
  if (!updated) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  await auditRun(updated, `workflow_change_${result}`, { documentId: run.document_id, runId: run.id, changeId, detail }, undefined, caller.agent);
  return NextResponse.json({ run: runView(updated) } satisfies RunResponse);
}
