import { NextRequest, NextResponse } from "next/server";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { MAX_RUN_HISTORY } from "@/lib/workflow/contract";
import { listDocumentRuns, recentRunSummaries } from "@/lib/workflow/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RUNS = 500;

/**
 * GET /api/workflow-runs/runs/history?documentId=[&limit=] — a document's runs
 * (RunBrief, newest first, at most MAX_RUN_HISTORY). Without documentId, the
 * team's newest runs across documents for the canvas's run log and overview
 * (RunSummary: a RunBrief with its steps and nodes).
 */
export async function GET(request: NextRequest) {
  const caller = await requireTeam(PERMISSIONS.workflowRead);
  if (caller instanceof NextResponse) return caller;
  const q = request.nextUrl.searchParams;
  const documentId = q.get("documentId");
  if (documentId) {
    const doc = isUuid(documentId) ? await getDocument(caller.teamId, documentId) : null;
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    const limit = Math.min(MAX_RUN_HISTORY, Math.max(1, Number(q.get("limit")) || MAX_RUN_HISTORY));
    return NextResponse.json({ runs: await listDocumentRuns(caller.teamId, doc.id, limit) });
  }
  const limit = Math.min(MAX_RUNS, Math.max(1, Number(q.get("limit")) || 200));
  return NextResponse.json({ runs: await recentRunSummaries(caller.teamId, limit), limit, persisted: !!process.env.POSTGRES_URL });
}
