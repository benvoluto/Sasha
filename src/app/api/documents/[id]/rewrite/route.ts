import { NextResponse } from "next/server";
import { z } from "zod";
import { getType } from "@/catalog";
import { getDocument } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { limitModelCall } from "@/lib/limits/http";
import { claudeConfigured, claudeText, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { contextFor, enterModelContext } from "@/lib/llm/context";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { groundingResolver, verifyMarkers, wordingChanged, WORDING_CHANGED_ERROR } from "@/lib/citations/verify";
import type { CitationReport } from "@/lib/citations/contract";
import { REWRITE_PRESETS } from "@/lib/report/rewrite-presets";
import { isCiteSources, logCitations } from "@/lib/sections/generate";
import { buildGrounding } from "@/lib/sections/grounding";
import { delimit, selectionRewriteSystem, stripFences } from "@/lib/sections/prompt";

export const dynamic = "force-dynamic";
// Draft-tier calls stream with an overall deadline (CLAUDE_STREAM_DEADLINE_MS)
// that fits inside this, so a slow call fails with a message (and an audit
// entry) instead of being killed.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Passages for a selection rewrite: fewer than a section draft, picked for the selection and the instruction. */
const REWRITE_GROUNDING_BUDGET = 12_000;

/** POST response: the rewritten passage, with its verified [[p:ID]] markers and the report on them (markCitations). */
export type RewriteResponse = { markdown: string; citations: CitationReport };

const Body = z
  .object({
    /** The selected text to rewrite; citations in it are sent as bare [[p:ID]] markers so the rewrite keeps them. */
    text: z.string().min(1).max(40_000),
    preset: z.string().optional(),
    direction: z.enum(["more", "less"]).optional(),
    instruction: z.string().max(2000).optional(),
  })
  .refine((b) => !!b.preset || !!b.instruction?.trim(), { message: "Choose a preset or write an instruction." });

/** POST /api/documents/[id]/rewrite — rewrite a selection with a preset or a freeform instruction. Counts one "draft" call. */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  enterModelContext(contextFor(caller, { documentId: id }));
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set, so rewriting is unavailable." }, { status: 503 });
  const doc = await getDocument(caller.teamId, id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { text, preset, direction, instruction } = parsed.data;
  const p = preset ? REWRITE_PRESETS[preset] : undefined;
  if (preset && !p) return NextResponse.json({ error: "Unknown preset." }, { status: 400 });
  const limited = await limitModelCall(caller, "draft");
  if (limited) return limited;
  const how = instruction?.trim() || (direction === "less" && p?.lessInstruction ? p.lessInstruction : p!.instruction);
  const type = (await getType(caller.teamId, doc.type_key))?.definition ?? null;
  // Linked, read sources give the model passages it can cite; none gives no <sources> block at all.
  const grounding = await buildGrounding(caller.teamId, doc.id, { focus: [text, how], budget: REWRITE_GROUNDING_BUDGET });
  const sources = grounding.sources.length ? grounding.block : "";

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
    const { markdown, report } = await verifyMarkers(stripFences(rewritten), groundingResolver(caller.teamId, doc.id, grounding));
    logCitations(report);
    if (isCiteSources({ instruction }) && wordingChanged(text, markdown)) return NextResponse.json({ error: WORDING_CHANGED_ERROR }, { status: 422 });
    return NextResponse.json({ markdown, citations: report } satisfies RewriteResponse);
  } catch (error) {
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof ModelDeadlineError) return NextResponse.json({ error: `${error.message} Try again.` }, { status: 504 });
    console.error("[rewrite] failed:", error);
    return NextResponse.json({ error: "The rewrite failed. Try again." }, { status: 502 });
  }
}
