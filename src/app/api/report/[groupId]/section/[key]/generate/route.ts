import { NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { generateSection, getReport } from "@/lib/ontology/report/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST /api/report/[groupId]/section/[key]/generate — (re)generate one section. */
export async function POST(_request: Request, { params }: { params: Promise<{ groupId: string; key: string }> }) {
  const { groupId, key } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const outcome = await generateSection(groupId, key, { auth });
  if ("error" in outcome) {
    const status = outcome.error.startsWith("permission denied") ? 403 : 400;
    return NextResponse.json({ error: outcome.error }, { status });
  }
  const report = await getReport(groupId);
  return NextResponse.json({ ok: true, ...(report ?? { report: null, sections: [] }) });
}
