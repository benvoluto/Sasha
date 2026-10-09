import { NextResponse } from "next/server";
import { issueLines } from "@/catalog/api";
import { requireTeam } from "@/lib/documents/team";
import { SaveLearnedRequest, type LearnErrorResponse } from "@/lib/learn/contract";
import { LearnInputError } from "@/lib/learn/examples";
import { saveLearned } from "@/lib/learn/save";
import { can } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (error: string, status: number, extra: Omit<LearnErrorResponse, "error"> = {}) => NextResponse.json({ error, ...extra } satisfies LearnErrorResponse, { status });

/**
 * POST /api/document-types/learn/save — the author checkpoint (PLAN §6.11).
 * Saves the reviewed draft as a team type, its inferred requirement sets and a
 * team workflow bound to the type. 422 (SaveLearnedBlocked) while the draft
 * doesn't validate, or still has copied text the author didn't keep or
 * personal details; 409 when the type's key or an alias is taken.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  // The workflow is saved with the type: both permissions.
  if (!can(caller, PERMISSIONS.workflowEdit)) return fail("You don't have permission to do that.", 403);
  const parsed = SaveLearnedRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issues = issueLines(parsed.error);
    return fail(`Invalid request: ${issues[0]}`, 400, { issues });
  }
  try {
    const result = await saveLearned(caller.teamId, caller, parsed.data);
    return NextResponse.json(result.body, { status: result.ok ? 201 : result.status });
  } catch (error) {
    if (error instanceof LearnInputError) return fail(error.message, error.status);
    console.error("[learn] save failed:", error);
    return fail("Saving the learned type failed. Try again.", 500);
  }
}
