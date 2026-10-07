import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { generateAll, getReport } from "@/lib/ontology/report/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST /api/report/[groupId]/generate — (re)generate all sections. Body: { force?, templateKey? }
 *  (templateKey only applies when the report is first created). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const outcome = await generateAll(groupId, {
    auth,
    force: body?.force === true,
    templateKey: typeof body?.templateKey === "string" ? body.templateKey : undefined,
  });
  if ("error" in outcome) {
    const status = outcome.error.startsWith("permission denied") ? 403 : 400;
    return NextResponse.json({ error: outcome.error }, { status });
  }
  const report = await getReport(groupId);
  return NextResponse.json({ ...outcome, ...(report ?? { report: null, sections: [] }) });
}
