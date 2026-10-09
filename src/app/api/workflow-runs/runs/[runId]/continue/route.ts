import { after, NextRequest, NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { releaseModelCall } from "@/lib/limits/limiter";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { ContinueRequest, type RunResponse } from "@/lib/workflow/contract";
import { checkpointDecisionFor } from "@/lib/workflow/core-nodes";
import { executeGraph, resetFailedSteps } from "@/lib/workflow/engine";
import { auditRun, claimRun, getRun, runView, saveRun } from "@/lib/workflow/store";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workflow-runs/runs/[runId]/continue — resume one of the team's runs:
 * - waiting at a checkpoint: body ContinueRequest with the decision
 *   (approve, edit or reject; edits and record fields as the checkpoint allows).
 *   At a checkpoint with named signers, each signs in turn (`signer`); the run
 *   stays waiting until the last one signs or one rejects;
 * - paused at the time budget: no body;
 * - failed: no body; the failed steps (and what depends on them) run again,
 *   a looping step only for its unfinished items.
 * 202 with the run; it continues in the background. The run's start paid
 * for its graph, so going on from a checkpoint or a pause is free: a long run
 * pauses at the time budget many times, and charging each continue spent the
 * hourly allowance mid-run. Retrying a failed run does the failed work again,
 * so it counts one "workflow" call (429 when the allowance is used up; a
 * refused retry gives it back).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await requireTeam(PERMISSIONS.workflowRun);
  if (caller instanceof NextResponse) return caller;
  const run = await getRun(caller.teamId, (await params).runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  enterModelContext(contextFor(caller, { documentId: run.document_id, runId: run.id }));
  const text = await request.text().catch(() => "");
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "The body must be JSON." }, { status: 400 });
    }
  }
  const parsed = ContinueRequest.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });

  if (run.status === "awaiting_review") {
    const cp = parsed.data.checkpoint;
    if (!cp) return NextResponse.json({ error: "Name the waiting checkpoint to continue." }, { status: 400 });
    let checked = await checkpointDecisionFor(run, cp, caller.agent);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    if (!(await claimRun(run, ["awaiting_review"]))) {
      return NextResponse.json({ error: "The run has already been continued." }, { status: 409 });
    }
    if (checked.signatures.length) {
      // Another signer may have signed since the run was read: check again against what is stored now.
      const latest = await getRun(caller.teamId, run.id);
      run.outputs[cp.nodeId] = latest?.outputs[cp.nodeId] ?? run.outputs[cp.nodeId];
      checked = await checkpointDecisionFor(run, cp, caller.agent);
      if (!checked.ok) {
        run.status = "awaiting_review";
        await saveRun(run);
        return NextResponse.json({ error: checked.error }, { status: 400 });
      }
    }
    if (!checked.complete) {
      // One of several named signers: keep the signature and go on waiting for the rest.
      const last = checked.signatures.at(-1)!;
      run.outputs[cp.nodeId] = { ...run.outputs[cp.nodeId], signatures: checked.signatures };
      run.status = "awaiting_review";
      await saveRun(run);
      await auditRun(run, "workflow_checkpoint_signed", { documentId: run.document_id, runId: run.id, nodeId: cp.nodeId, verdict: last.verdict, signer: last.signer, edits: last.edits }, cp.note || undefined, caller.agent);
      return NextResponse.json({ run: runView(run) } satisfies RunResponse, { status: 202 });
    }
    run.checkpoints[cp.nodeId] = checked.decision;
    run.steps[cp.nodeId] = { status: "pending" };
    await saveRun(run);
    const { verdict, role, excluded, edits } = checked.decision;
    const signer = checked.signatures.at(-1)?.signer;
    await auditRun(run, "workflow_checkpoint_decided", { documentId: run.document_id, runId: run.id, nodeId: cp.nodeId, verdict, role, excluded, edits, ...(signer ? { signer } : {}) }, cp.note || undefined, caller.agent);
  } else if (run.status === "paused") {
    if (!(await claimRun(run, ["paused"]))) {
      return NextResponse.json({ error: "The run has already been continued." }, { status: 409 });
    }
  } else if (run.status === "failed") {
    // A run that stopped responding reads as failed but is stored as running.
    const limited = await limitModelCall(caller, "workflow");
    if (limited) return limited;
    if (!(await claimRun(run, ["failed", "running"]))) {
      await releaseModelCall(caller, "workflow");
      return NextResponse.json({ error: "The run has already been continued." }, { status: 409 });
    }
    resetFailedSteps(run);
    await saveRun(run);
    await auditRun(run, "workflow_run_retried", { documentId: run.document_id, runId: run.id }, undefined, caller.agent);
  } else {
    return NextResponse.json({ error: `A ${run.status.replace("_", " ")} run can't be continued.` }, { status: 409 });
  }

  after(() => executeGraph(run));
  return NextResponse.json({ run: runView(run) } satisfies RunResponse, { status: 202 });
}
