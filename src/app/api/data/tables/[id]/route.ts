import { NextResponse } from "next/server";
import { DataTablePatch, TableRowsQuery, type TablePatchResponse, type TableResponse } from "@/lib/data/contract";
import { getTable, getTableRows, patchTable, type PatchResult } from "@/lib/data/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "Table not found." }, { status: 404 });

/** GET /api/data/tables/[id]?offset=&limit= — the table and a page of its rows (overrides applied). */
export async function GET(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const parsed = TableRowsQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "That page of rows isn't valid." }, { status: 400 });
  const { id } = await params;
  const table = await getTable(caller.teamId, id);
  if (!table) return notFound();
  const { offset, limit } = parsed.data;
  const rows = (await getTableRows(caller.teamId, id, offset, limit)) ?? [];
  const end = offset + rows.length;
  return NextResponse.json({ table, rows, offset, next_offset: rows.length && end < table.row_count ? end : null } satisfies TableResponse);
}

const FAILURES: Record<Exclude<PatchResult, { ok: true }>["reason"], [number, string]> = {
  not_found: [404, "Table not found."],
  column_not_found: [400, "That column isn't in this table."],
  row_not_found: [400, "That row isn't in this table."],
  invalid_state: [409, "That change doesn't apply to this table."],
  invalid_supersede: [409, "That change doesn't apply to this table."],
  not_superseded: [409, "That change doesn't apply to this table."],
  no_override: [409, "That change doesn't apply to this table."],
};

/** PATCH /api/data/tables/[id] — one change: rename, column, hide/unhide, supersede/restore, override/revert. */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = DataTablePatch.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "That change isn't valid." }, { status: 400 });
  const result = await patchTable(caller.teamId, caller.agent, (await params).id, parsed.data);
  if (!result.ok) {
    const [status, error] = FAILURES[result.reason];
    return NextResponse.json({ error }, { status });
  }
  return NextResponse.json({ table: result.table, ...(result.row ? { row: result.row } : {}) } satisfies TablePatchResponse);
}
