import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { defaultAuditSink } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { applySuggestionEdit, getSuggestionEdits } from "@/lib/ontology/suggestion-edits";

export const runtime = "nodejs";

const Body = z.object({
  kind: z.enum(["sources", "data"]),
  action: z.enum(["dismiss", "restore", "add", "remove"]),
  name: z.string().trim().min(1).max(200),
});

/** GET /api/cases/[groupId]/suggestions — the team's dismissed and added suggestions for the document. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  if (!(await authFromClerk())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { groupId } = await params;
  return NextResponse.json({ suggestionEdits: await getSuggestionEdits(groupId) });
}

/**
 * POST /api/cases/[groupId]/suggestions — dismiss or restore a suggested
 * source/data item, or add or remove one the team wants. Body: { kind, action, name }.
 * Returns the document's updated edits.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { groupId } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "kind, action and name are required" }, { status: 400 });
  const { kind, action, name } = parsed.data;
  const suggestionEdits = await applySuggestionEdit(groupId, kind, action, name, caller.agent);
  await defaultAuditSink().write({ agent: caller.agent, action: `suggestion_${action}`, args: { group_id: groupId, kind, name }, result: { ok: true }, allowed: true, groupId });
  return NextResponse.json({ suggestionEdits });
}
