import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { updateSection } from "@/lib/ontology/report/service";
import type { PMDoc } from "@/lib/report/markdown-to-tiptap";

export const runtime = "nodejs";

/** PATCH /api/report/[groupId]/section/[key] — autosave a section's edited content. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ groupId: string; key: string }> }) {
  const { groupId, key } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { contentJson?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const doc = body.contentJson as PMDoc | undefined;
  if (!doc || doc.type !== "doc") return NextResponse.json({ error: "contentJson (a ProseMirror doc) is required" }, { status: 400 });

  const outcome = await updateSection(groupId, key, doc, { auth });
  if ("error" in outcome) {
    const status = outcome.error.startsWith("permission denied") ? 403 : 400;
    return NextResponse.json({ error: outcome.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
