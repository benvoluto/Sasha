import { NextRequest, NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { FindingResponseRequest, type RunResponse } from "@/lib/workflow/contract";
import { auditRun, getRun, recordFindingResponse, runView } from "@/lib/workflow/store";

export const runtime = "nodejs";

/**
 * POST /api/workflow-runs/runs/[runId]/findings — the author accepts or
 * dismisses one of the outcome's findings ("open" undoes it). Body:
 * FindingResponseRequest. Returns the run.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await requireTeam(PERMISSIONS.workflowRun);
  if (caller instanceof NextResponse) return caller;
  const run = await getRun(caller.teamId, (await params).runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  const parsed = FindingResponseRequest.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const { findingId, state } = parsed.data;
  if (!run.outcome?.findings.some((f) => f.id === findingId)) return NextResponse.json({ error: "The run has no such finding." }, { status: 400 });
  const updated = await recordFindingResponse(caller.teamId, run.id, findingId, { state, by: caller.agent, at: new Date().toISOString() });
  if (!updated) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  await auditRun(updated, "workflow_finding_response", { documentId: run.document_id, runId: run.id, findingId, state }, undefined, caller.agent);
  return NextResponse.json({ run: runView(updated) } satisfies RunResponse);
}
