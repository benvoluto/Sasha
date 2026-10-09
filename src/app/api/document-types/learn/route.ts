import { NextResponse } from "next/server";
import { issueLines } from "@/catalog/api";
import { requireTeam } from "@/lib/documents/team";
import { claudeConfigured, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { LearnRequest, LEARN_TEAM_HOURLY_LIMIT, type LearnErrorResponse, type LearnResponse } from "@/lib/learn/contract";
import { LearnInputError, readExamples, uniqueRefs } from "@/lib/learn/examples";
import { extractFromExamples, LearnModelError } from "@/lib/learn/extract";
import { reserveLearnCall } from "@/lib/learn/store";
import { defaultAuditSink } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One Opus call (learn.extract, streamed) and at most one repair round, inside the extraction's own budget.
export const maxDuration = 300;

const fail = (error: string, status: number, extra: Omit<LearnErrorResponse, "error"> = {}) => NextResponse.json({ error, ...extra } satisfies LearnErrorResponse, { status });

/**
 * POST /api/document-types/learn — learn a draft document type and review
 * workflow from 1–5 examples (PLAN §6.11). Nothing is saved: the author
 * reviews the draft and saves it through ./save. The examples are checked
 * before the team's hourly allowance is spent on them.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  if (!claudeConfigured()) return fail("Claude is not configured.", 503);
  const parsed = LearnRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issues = issueLines(parsed.error);
    return fail(`Invalid request: ${issues[0]}`, 400, { issues });
  }
  const body = parsed.data;
  const started = Date.now();

  let examples;
  try {
    examples = await readExamples(caller.teamId, uniqueRefs(body.examples));
  } catch (error) {
    if (error instanceof LearnInputError) return fail(error.message, error.status);
    throw error;
  }

  const gate = await reserveLearnCall(caller.teamId);
  if (!gate.ok) {
    return fail(`Your team has learned ${LEARN_TEAM_HOURLY_LIMIT} types in the last hour. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minutes.`, 429, { retryAfterSeconds: gate.retryAfterSeconds });
  }

  const audit = (result: Record<string, unknown>, allowed = true) =>
    defaultAuditSink()
      .write({ agent: caller.agent, action: "learn_type_extract", args: { examples: examples.length, documentId: body.documentId ?? null }, result, allowed })
      .catch((e: unknown) => console.error("[learn] audit write failed:", e));
  try {
    const { draft, usage, repaired } = await extractFromExamples(caller.teamId, examples, body, { agent: caller.agent, started });
    // Counts only: never example text or the draft.
    await audit({
      type: draft.type.key,
      confidence: draft.confidence,
      repaired,
      overlaps: draft.overlaps.length,
      personalDetails: draft.personalDetails.length,
      invalid: Object.values(draft.validation).reduce((n, v) => n + v.length, 0),
      tokens: usage.reduce((n, u) => n + u.input_tokens + u.output_tokens, 0),
    });
    return NextResponse.json({ draft } satisfies LearnResponse);
  } catch (error) {
    await audit({ error: error instanceof Error ? error.message : String(error) }, false);
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError || error instanceof LearnModelError) return fail(error.message, 422);
    if (error instanceof ModelDeadlineError) return fail(`${error.message} Try fewer or shorter examples.`, 504);
    console.error("[learn] extraction failed:", error);
    return fail("Learning from the examples failed. Try again.", 502);
  }
}
