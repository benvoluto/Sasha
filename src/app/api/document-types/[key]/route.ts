import { NextResponse } from "next/server";
import { invalidDefinition, issueLines } from "@/catalog/api";
import { getType, removeTypeEdits, saveTypeDefinition, setTypeEnabled } from "@/catalog/index";
import { toTypeSummary, type CatalogEntry } from "@/catalog/schema";
import { requireTeam } from "@/lib/documents/team";
import { can } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { EnableTypeRequest, UpdateTypeRequest, type DocumentTypeResponse } from "@/lib/sections/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

const notFound = () => NextResponse.json({ error: "Document type not found." }, { status: 404 });

function detail(entry: CatalogEntry, editable: boolean): DocumentTypeResponse {
  const { definition, origin, enabled, overridden, updated_at } = entry;
  return { type: definition, meta: { origin, enabled, overridden, updated_at, editable } };
}

/** GET /api/document-types/[key] — the full definition as the team sees it (aliases resolve; disabled types too). */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const entry = await getType(caller.teamId, (await params).key);
  if (!entry) return notFound();
  return NextResponse.json(detail(entry, can(caller, PERMISSIONS.settingsWrite)));
}

/**
 * PUT /api/document-types/[key] — replace the team's definition. A catalog
 * type gets (or updates) the team's override; a team type is updated. The
 * stored version is bumped by the server whatever the body says.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.settingsWrite);
  if (caller instanceof NextResponse) return caller;
  const key = (await params).key;
  const parsed = UpdateTypeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidDefinition(issueLines(parsed.error));
  const result = await saveTypeDefinition(caller.teamId, caller.agent, key, parsed.data.definition);
  if (!result.ok) {
    if (result.reason === "not_found") return notFound();
    if (result.reason === "key_mismatch") return NextResponse.json({ error: result.message, issues: [`key: ${result.message}`] }, { status: 400 });
    return NextResponse.json({ error: result.message }, { status: 409 });
  }
  return NextResponse.json({ type: toTypeSummary(result.entry) });
}

/** PATCH /api/document-types/[key] — enable or disable the type for the team. */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.settingsWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = EnableTypeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send { enabled: true | false }." }, { status: 400 });
  const entry = await setTypeEnabled(caller.teamId, caller.agent, (await params).key, parsed.data.enabled);
  if (!entry) return notFound();
  return NextResponse.json({ type: toTypeSummary(entry) });
}

/** DELETE /api/document-types/[key] — delete a team type, or revert a catalog type to the catalog's definition. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.settingsWrite);
  if (caller instanceof NextResponse) return caller;
  const done = await removeTypeEdits(caller.teamId, caller.agent, (await params).key);
  if (!done) return NextResponse.json({ error: "Nothing to delete or revert." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
