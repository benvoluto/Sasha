import { after, NextRequest, NextResponse } from "next/server";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { RUN_PERMISSION, auditRun, claimRun, getRun } from "@/lib/workflow/store";
import { executeGraph } from "@/lib/workflow/engine";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workflow-runs/runs/[runId]/continue
 * Resume a run paused at the time limit, or one waiting at a human checkpoint.
 * For a checkpoint, body: { checkpoint: { nodeId, excluded: number[], note } }
 * where `excluded` lists the positions of items to leave out.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, RUN_PERMISSION)) return NextResponse.json({ error: `permission denied: requires '${RUN_PERMISSION}'` }, { status: 403 });

  const { runId } = await params;
  const run = await getRun(runId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  let body: { checkpoint?: { nodeId?: unknown; excluded?: unknown; note?: unknown } } = {};
  try {
    body = await request.json();
  } catch {
    // no body: a plain continue
  }

  if (run.status === "awaiting_review") {
    const cp = body.checkpoint;
    const nodeId = typeof cp?.nodeId === "string" ? cp.nodeId : "";
    if (!nodeId || run.steps[nodeId]?.status !== "waiting") return NextResponse.json({ error: "name the waiting checkpoint to continue" }, { status: 400 });
    const pending = ((run.outputs[nodeId]?.pending_items as unknown[]) ?? []).length;
    const excluded = Array.isArray(cp?.excluded) ? cp.excluded.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < pending) : [];
    const note = typeof cp?.note === "string" ? cp.note.slice(0, 4000) : "";
    if (!(await claimRun(run, ["awaiting_review"]))) return NextResponse.json({ error: "the run has already been continued" }, { status: 409 });
    run.checkpoints[nodeId] = { excluded, note, by: caller.agent, at: new Date().toISOString() };
    run.steps[nodeId] = { status: "pending" };
    await auditRun(run, "workflow_checkpoint_continued", { nodeId, excluded, note }, undefined, caller.agent);
  } else if (run.status === "paused") {
    if (!(await claimRun(run, ["paused"]))) return NextResponse.json({ error: "the run has already been continued" }, { status: 409 });
  } else {
    return NextResponse.json({ error: `a ${run.status} run cannot be continued` }, { status: 409 });
  }

  after(() => executeGraph(run));
  return NextResponse.json({ run }, { status: 202 });
}
