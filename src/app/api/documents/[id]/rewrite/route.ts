import { NextResponse } from "next/server";
import { z } from "zod";
import { getType } from "@/catalog";
import { getDocument } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { claudeConfigured, claudeText, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { REWRITE_PRESETS } from "@/lib/report/rewrite-presets";
import { sourceSummariesBlock } from "@/lib/sections/grounding";
import { delimit, selectionRewriteSystem } from "@/lib/sections/prompt";

export const dynamic = "force-dynamic";
// Draft-tier calls stream with an overall deadline (CLAUDE_STREAM_DEADLINE_MS)
// that fits inside this, so a slow call fails with a message (and an audit
// entry) instead of being killed.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const Body = z
  .object({
    /** The selected text to rewrite. */
    text: z.string().min(1).max(40_000),
    preset: z.string().optional(),
    direction: z.enum(["more", "less"]).optional(),
    instruction: z.string().max(2000).optional(),
  })
  .refine((b) => !!b.preset || !!b.instruction?.trim(), { message: "Choose a preset or write an instruction." });

/** POST /api/documents/[id]/rewrite — rewrite a selection with a preset or a freeform instruction. */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set, so rewriting is unavailable." }, { status: 503 });
  const doc = await getDocument(caller.teamId, (await params).id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { text, preset, direction, instruction } = parsed.data;
  const p = preset ? REWRITE_PRESETS[preset] : undefined;
  if (preset && !p) return NextResponse.json({ error: "Unknown preset." }, { status: 400 });
  const how = instruction?.trim() || (direction === "less" && p?.lessInstruction ? p.lessInstruction : p!.instruction);
  const type = (await getType(caller.teamId, doc.type_key))?.definition ?? null;
  const sources = await sourceSummariesBlock(caller.teamId, doc.id);

  const user = [
    `Document title: ${doc.title || "Untitled"}`,
    type ? `Document type: ${type.title}` : "",
    // Document text and the selection are untrusted (pasted text can contain the tags), so both are delimited with the tag defused inside.
    delimit("document_context", doc.content_text.slice(0, 20_000)),
    sources,
    `Instruction: ${how}`,
    delimit("passage", text),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text: rewritten } = await claudeText({ task: "rewrite.selection", system: selectionRewriteSystem(type), user, agent: caller.agent, documentId: doc.id });
    return NextResponse.json({ markdown: rewritten });
  } catch (error) {
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof ModelDeadlineError) return NextResponse.json({ error: `${error.message} Try again.` }, { status: 504 });
    console.error("[rewrite] failed:", error);
    return NextResponse.json({ error: "The rewrite failed. Try again." }, { status: 502 });
  }
}
