import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { renameWorkflow } from "@/lib/workflow/store";

export const runtime = "nodejs";

/** PATCH /api/workflows/[id] — rename a workflow. Body: { name }. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await authFromClerk();
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(caller, "workflow:write")) return NextResponse.json({ error: "permission denied: requires 'workflow:write'" }, { status: 403 });
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "a name is required" }, { status: 400 });
  const { id } = await params;
  if (!(await renameWorkflow(id, parsed.data.name, caller))) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
