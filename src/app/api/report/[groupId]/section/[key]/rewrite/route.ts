import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { rewriteSection, getReport } from "@/lib/ontology/report/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST /api/report/[groupId]/section/[key]/rewrite — model-transform one section
 *  with a preset or freeform instruction, grounded in its facts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string; key: string }> }) {
  const { groupId, key } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { preset?: unknown; instruction?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const preset = typeof body.preset === "string" ? body.preset : undefined;
  const instruction = typeof body.instruction === "string" ? body.instruction : undefined;

  const outcome = await rewriteSection(groupId, key, { preset, instruction, auth });
  if ("error" in outcome) {
    const status = outcome.error.startsWith("permission denied") ? 403 : 400;
    return NextResponse.json({ error: outcome.error }, { status });
  }
  const report = await getReport(groupId);
  return NextResponse.json({ ok: true, ...(report ?? { report: null, sections: [] }) });
}
