import { NextResponse } from "next/server";
import { isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { releaseModelCall } from "@/lib/limits/limiter";
import { claudeConfigured, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { SectionGenerateRequest, SectionId, type SectionGenerateResponse } from "@/lib/sections/contract";
import { generateSection, REFUSED_BEFORE_MODEL } from "@/lib/sections/generate";

export const dynamic = "force-dynamic";
// Draft-tier calls stream with an overall deadline (CLAUDE_STREAM_DEADLINE_MS)
// that fits inside this, so a slow call fails with a message (and an audit
// entry) instead of being killed.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; sectionId: string }> };

/**
 * POST /api/documents/[id]/sections/[sectionId]/generate — draft or rewrite one
 * section. Returns the new body as Markdown; the editor inserts it (after its
 * own version snapshot), so the stored document is never written here.
 * Counts one call of the caller's "draft" allowance (429 when it is used up).
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id, sectionId } = await params;
  enterModelContext(contextFor(caller, { documentId: isUuid(id) ? id : null }));
  if (!isUuid(id) || !SectionId.safeParse(sectionId).success) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const parsed = SectionGenerateRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "Claude is not configured." }, { status: 503 });
  const limited = await limitModelCall(caller, "draft");
  if (limited) return limited;

  try {
    const result = await generateSection({ teamId: caller.teamId, agent: caller.agent, documentId: id, sectionId, req: parsed.data });
    if (!result.ok) {
      // Refused before the model ran (missing document, static section, no notes): give the call back.
      // A failure after the call (reworded citations, document deleted mid-call) stays charged.
      if (REFUSED_BEFORE_MODEL.has(result.code)) await releaseModelCall(caller, "draft");
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.response satisfies SectionGenerateResponse);
  } catch (error) {
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof ModelDeadlineError) return NextResponse.json({ error: `${error.message} Try again.` }, { status: 504 });
    console.error("[sections/generate] failed:", error);
    return NextResponse.json({ error: "Drafting failed. Try again." }, { status: 502 });
  }
}
