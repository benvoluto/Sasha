import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { setSectionReviewed, getReport } from "@/lib/ontology/report/service";

export const runtime = "nodejs";

/** POST /api/report/[groupId]/section/[key]/review — mark reviewed (or clear it). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string; key: string }> }) {
  const { groupId, key } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { reviewed?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // default to marking reviewed when no body is sent
  }
  const reviewed = body.reviewed !== false; // default true

  const outcome = await setSectionReviewed(groupId, key, reviewed, { auth });
  if ("error" in outcome) {
    const status = outcome.error.startsWith("permission denied") ? 403 : 400;
    return NextResponse.json({ error: outcome.error }, { status });
  }
  const report = await getReport(groupId);
  return NextResponse.json({ ok: true, ...(report ?? { report: null, sections: [] }) });
}
