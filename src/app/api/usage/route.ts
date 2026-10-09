import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { UsageQuery } from "@/lib/usage/contract";
import { usageCsv, usageCsvFilename } from "@/lib/usage/csv";
import { csvGroups, loadUsageRows, resolveRange, summarize } from "@/lib/usage/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv] — the caller's
 * team's model usage and estimated cost for a range of UTC days (contract in
 * src/lib/usage/contract.ts). format=csv downloads one row per day, user,
 * task and model.
 */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.auditRead);
  if (caller instanceof NextResponse) return caller;
  const params = new URL(req.url).searchParams;
  // Empty values count as absent, so a form that sends from= still gets the default.
  const raw = Object.fromEntries(["from", "to", "format"].flatMap((k) => (params.get(k) ? [[k, params.get(k)]] : [])));
  const parsed = UsageQuery.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query." }, { status: 400 });
  const range = resolveRange(parsed.data);
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });

  const { rows, memoryOnly } = await loadUsageRows(caller.teamId, range);
  if (parsed.data.format === "csv") {
    return new Response("﻿" + usageCsv(csvGroups(rows)), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${usageCsvFilename(range)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json(summarize(rows, range, memoryOnly), { headers: { "Cache-Control": "no-store" } });
}
