import { after, NextRequest, NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { ChangeResultRequest, type ChangeResult, type RunResponse } from "@/lib/workflow/contract";
import { executeGraph } from "@/lib/workflow/engine";
import { auditRun, claimRun, getRun, proposedChanges, recordChangeResultOnce, runView, saveRun } from "@/lib/workflow/store";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workflow-runs/runs/[runId]/changes — record what happened to a
 * change the run proposed (the open editor applied it, the person discarded
 * it, or it was skipped). Body: ChangeResultRequest; `lines` gives each line's
 * result for a change with line edits (replace_lines) and is refused for any
 * other change. A change is recorded once (409 for a second result).
 *
 * When the run is waiting on this change (doc.write with waitForResult, run
 * awaiting review), recording it resumes the run: 202, and it continues in the
 * background, free like continuing from a checkpoint (the run's start paid for
 * its graph). Otherwise 200 with the run; a result recorded while the run is
 * still running is picked up by the engine once it stops to wait.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await requireTeam(PERMISSIONS.workflowRun);
  if (caller instanceof NextResponse) return caller;
  const run = await getRun(caller.teamId, (await params).runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  const parsed = ChangeResultRequest.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const { changeId, result, detail, lines } = parsed.data;
  const change = proposedChanges(run).find((c) => c.id === changeId);
  if (!change) return NextResponse.json({ error: "The run proposed no such change." }, { status: 400 });
  if (run.changes?.[changeId]) return NextResponse.json({ error: "This change has already been recorded." }, { status: 409 });
  if (lines) {
    const ops = change.ops.filter((o) => o.op === "replace_lines");
    if (!ops.length) return NextResponse.json({ error: "Line results are only for a change with line edits." }, { status: 400 });
    const known = new Set(ops.flatMap((o) => o.lines.map((l) => l.id)));
    const seen = new Set<string>();
    for (const l of lines) {
      if (!known.has(l.lineId)) return NextResponse.json({ error: `Unknown line “${l.lineId}”.` }, { status: 400 });
      if (seen.has(l.lineId)) return NextResponse.json({ error: `Line “${l.lineId}” is listed twice.` }, { status: 400 });
      seen.add(l.lineId);
    }
  }
  const recorded: ChangeResult = { result, by: caller.agent, at: new Date().toISOString(), detail, ...(lines ? { lines } : {}) };
  // Recorded only if no result is yet: the check above read an earlier copy, and a second tab may have recorded since.
  const updated = await recordChangeResultOnce(caller.teamId, run.id, changeId, recorded);
  if (updated === "exists") return NextResponse.json({ error: "This change has already been recorded." }, { status: 409 });
  if (!updated) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  const counts = lines && Object.fromEntries((["accepted", "rejected", "skipped"] as const).map((k) => [k, lines.filter((l) => l.result === k).length]));
  await auditRun(updated, `workflow_change_${result}`, { documentId: run.document_id, runId: run.id, changeId, detail, ...(counts ? { lines: counts } : {}) }, undefined, caller.agent);

  if (updated.steps[changeId]?.status === "waiting" && updated.status === "awaiting_review") {
    enterModelContext(contextFor(caller, { documentId: updated.document_id, runId: updated.id }));
    if (await claimRun(updated, ["awaiting_review"])) {
      updated.steps[changeId] = { status: "pending" };
      await saveRun(updated);
      after(() => executeGraph(updated));
      return NextResponse.json({ run: runView(updated) } satisfies RunResponse, { status: 202 });
    }
  }
  return NextResponse.json({ run: runView(updated) } satisfies RunResponse);
}
