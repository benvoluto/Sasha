import { NextResponse } from "next/server";
import { invalidDefinition, issueLines } from "@/catalog/api";
import { createTeamType, listTypeSummaries } from "@/catalog/index";
import { toTypeSummary } from "@/catalog/schema";
import { requireTeam } from "@/lib/documents/team";
import { can } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { CreateTypeRequest, type DocumentTypesResponse } from "@/lib/sections/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/document-types — the team's enabled document types (catalog types
 * with the team's edits, plus team-made types), sorted by family then title.
 * `?all=1` (settings:write) includes disabled types, for the admin page.
 */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const all = ["1", "true"].includes(new URL(req.url).searchParams.get("all") ?? "");
  if (all && !can(caller, PERMISSIONS.settingsWrite)) {
    return NextResponse.json({ error: "Only a team admin can see disabled document types." }, { status: 403 });
  }
  const body: DocumentTypesResponse = { types: await listTypeSummaries(caller.teamId, { includeDisabled: all }) };
  return NextResponse.json(body);
}

/** POST /api/document-types — create a team-made type from a full definition. */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.settingsWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = CreateTypeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidDefinition(issueLines(parsed.error));
  const result = await createTeamType(caller.teamId, caller.agent, parsed.data.definition);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 409 });
  return NextResponse.json({ type: toTypeSummary(result.entry) }, { status: 201 });
}
