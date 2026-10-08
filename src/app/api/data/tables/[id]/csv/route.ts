import { NextResponse } from "next/server";
import { toCsv } from "@/lib/data/contract";
import { getTable, getTableRows } from "@/lib/data/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The download's file name: the table name without path or control characters, ending .csv. */
function csvFilename(name: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "table";
  return /\.csv$/i.test(base) ? base : `${base}.csv`;
}

/** RFC 6266 filename parameters: an ASCII fallback plus the UTF-8 original. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/data/tables/[id]/csv — every row with overrides applied, as a CSV
 * attachment. A UTF-8 BOM lets Excel read the encoding; every cell goes
 * through toCsv, so nothing in it runs as a formula when opened.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  const table = await getTable(caller.teamId, id);
  if (!table) return NextResponse.json({ error: "Table not found." }, { status: 404 });
  const rows = (await getTableRows(caller.teamId, id, 0, Math.max(table.row_count, 1))) ?? [];
  const body = "\uFEFF" + toCsv(table.columns, rows.map((r) => r.cells));
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": disposition(csvFilename(table.name)),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
