import { NextRequest, NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import type { RunResponse } from "@/lib/workflow/contract";
import { getRun, runView } from "@/lib/workflow/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workflow-runs/runs/[runId] — one of the team's runs, for polling its progress. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await requireTeam(PERMISSIONS.workflowRead);
  if (caller instanceof NextResponse) return caller;
  const run = await getRun(caller.teamId, (await params).runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ run: runView(run) } satisfies RunResponse);
}
