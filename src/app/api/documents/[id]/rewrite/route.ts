import { NextResponse } from "next/server";
import { z } from "zod";
import { getDocument } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { documentTypeByKey } from "@/lib/documents/types";
import { claudeConfigured, claudeText, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { REWRITE_PRESETS } from "@/lib/report/rewrite-presets";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

const SYSTEM = `You rewrite passages of a document the user is writing.
Return only the rewritten passage as Markdown, with no preamble, quotation marks or commentary.
Keep every fact, figure, name and date from the original unless the instruction says to remove it. Do not add facts that are not in the passage or the document context.
Match the document's existing voice unless the instruction asks for a different one.`;

/** POST /api/documents/[id]/rewrite — rewrite a selection with a preset or a freeform instruction. */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  if (!claudeConfigured()) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set, so rewriting is unavailable." }, { status: 503 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const doc = await getDocument(caller.teamId, (await params).id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { text, preset, direction, instruction } = parsed.data;
  const p = preset ? REWRITE_PRESETS[preset] : undefined;
  if (preset && !p) return NextResponse.json({ error: "Unknown preset." }, { status: 400 });
  const how = instruction?.trim() || (direction === "less" && p?.lessInstruction ? p.lessInstruction : p!.instruction);
  const type = documentTypeByKey(doc.type_key);

  const user = [
    `Document title: ${doc.title || "Untitled"}`,
    type ? `Document type: ${type.title}` : "",
    "<document_context>",
    doc.content_text.slice(0, 20_000),
    "</document_context>",
    `Instruction: ${how}`,
    "<passage>",
    text,
    "</passage>",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text: rewritten } = await claudeText({ task: "rewrite.selection", system: SYSTEM, user, agent: caller.agent, documentId: doc.id });
    return NextResponse.json({ markdown: rewritten });
  } catch (error) {
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("[rewrite] failed:", error);
    return NextResponse.json({ error: "The rewrite failed. Try again." }, { status: 502 });
  }
}
