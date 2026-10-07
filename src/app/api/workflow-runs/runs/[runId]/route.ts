import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { getRun } from "@/lib/workflow/store";

export const runtime = "nodejs";

/** GET /api/workflow-runs/runs/[runId] — one run, for polling its progress. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { runId } = await params;
  const run = await getRun(runId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json({ run });
}
