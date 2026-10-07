import { NextRequest, NextResponse } from "next/server";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { RUN_READ_PERMISSION, runAuditTrail } from "@/lib/workflow/store";

export const runtime = "nodejs";

/** GET /api/workflow-runs/runs/[runId]/events — the audit log's entries for one run. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, RUN_READ_PERMISSION)) return NextResponse.json({ error: `permission denied: requires '${RUN_READ_PERMISSION}'` }, { status: 403 });
  const { runId } = await params;
  return NextResponse.json({ events: await runAuditTrail(runId), persisted: !!process.env.POSTGRES_URL });
}
