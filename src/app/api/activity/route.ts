import { NextResponse } from "next/server";
import { ACTIVITY_LIMIT_MAX, type ActivityResponse } from "@/lib/activity/contract";
import { activityFeed } from "@/lib/activity/feed";
import { requireTeam } from "@/lib/documents/team";
import { can } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;

/**
 * GET /api/activity?limit= — the team's recent activity, newest first
 * (redesign3-spec.md §9): documents created or edited, and workflow runs when
 * the caller may read workflows. `limit` defaults to 50 and is capped at
 * ACTIVITY_LIMIT_MAX.
 */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const raw = new URL(req.url).searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Invalid limit." }, { status: 400 });
    limit = Math.min(n, ACTIVITY_LIMIT_MAX);
  }
  const items = await activityFeed(caller.teamId, { limit, includeRuns: can(caller, PERMISSIONS.workflowRead) });
  return NextResponse.json({ items } satisfies ActivityResponse);
}
