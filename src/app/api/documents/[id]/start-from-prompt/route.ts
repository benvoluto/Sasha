import { NextResponse } from "next/server";
import { normalizeResult } from "@/lib/classifier/classify";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { claudeConfigured, claudeJson, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { pickPromptType, PromptTypeModelOutput, StartFromPromptRequest, type StartFromPromptResponse } from "@/lib/tell-me/contract";
import { promptTypeSystem, promptTypeUser } from "@/lib/tell-me/prompt";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Longest title taken from the model. */
const TITLE_MAX = 120;

/**
 * POST /api/documents/[id]/start-from-prompt — pick a document type (and a
 * title) for "tell me what doc you'd like" (redesign2-spec.md §6.1). One
 * fast-tier `classify.prompt` call, counted against the caller's "light"
 * allowance. Stores nothing: the editor sets the type and notes through
 * autosave, then drafts each section through the section generate route.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  enterModelContext(contextFor(caller, { documentId: isUuid(id) ? id : null }));
  const doc = isUuid(id) ? await getDocument(caller.teamId, id) : null;
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const parsed = StartFromPromptRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "Claude is not configured, so Sasha can't start from a prompt." }, { status: 503 });
  const limited = await limitModelCall(caller, "light");
  if (limited) return limited;

  try {
    const { system, keys } = await promptTypeSystem(caller.teamId);
    const user = promptTypeUser({ title: doc.title, prompt: parsed.data.prompt });
    const { data } = await claudeJson({ task: "classify.prompt", system, user, schema: PromptTypeModelOutput, agent: caller.agent, documentId: doc.id });
    const result = normalizeResult({ candidates: data.candidates, freeform: data.freeform }, keys);
    return NextResponse.json({
      typeKey: pickPromptType(result),
      title: data.title.trim().slice(0, TITLE_MAX) || null,
      why: result.candidates[0]?.why ?? null,
      candidates: result.candidates,
    } satisfies StartFromPromptResponse);
  } catch (error) {
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof ModelDeadlineError) return NextResponse.json({ error: `${error.message} Try again.` }, { status: 504 });
    console.error("[start-from-prompt] failed:", error);
    return NextResponse.json({ error: "Sasha couldn't read that request. Try again." }, { status: 502 });
  }
}
