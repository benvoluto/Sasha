import { NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { getReport } from "@/lib/ontology/report/service";
import { REPORT_TEMPLATES } from "@/lib/ontology/report/template";

export const runtime = "nodejs";

const templates = REPORT_TEMPLATES.map((t) => ({ key: t.key, title: t.title }));

/** GET /api/report/[groupId] — the report + its sections (or an empty shell),
 *  plus the templates a new report can start from. */
export async function GET(_request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const report = await getReport(groupId);
    return NextResponse.json({ ...(report ?? { report: null, sections: [] }), templates });
  } catch (error) {
    console.error("[report] GET failed:", error);
    return NextResponse.json({ report: null, sections: [], templates });
  }
}
