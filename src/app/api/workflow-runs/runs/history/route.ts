import { NextRequest, NextResponse } from "next/server";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { RUN_READ_PERMISSION, listRunSummaries } from "@/lib/workflow/store";

export const runtime = "nodejs";

const MAX_RUNS = 500;

/** GET /api/workflow-runs/runs/history?limit= — the newest runs across all uploads, without their outputs. */
export async function GET(request: NextRequest) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, RUN_READ_PERMISSION)) return NextResponse.json({ error: `permission denied: requires '${RUN_READ_PERMISSION}'` }, { status: 403 });
  const limit = Math.min(MAX_RUNS, Math.max(1, Number(request.nextUrl.searchParams.get("limit")) || 200));
  return NextResponse.json({ runs: await listRunSummaries(limit), limit, persisted: !!process.env.POSTGRES_URL });
}
