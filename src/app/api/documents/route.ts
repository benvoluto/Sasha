import { NextResponse } from "next/server";
import { z } from "zod";
import { createDocument, listDocuments } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

/** GET /api/documents?q=&archived=1 — the team's documents, newest first. */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const url = new URL(req.url);
  const documents = await listDocuments(caller.teamId, {
    query: url.searchParams.get("q") ?? "",
    archived: url.searchParams.get("archived") === "1",
  });
  return NextResponse.json({ documents });
}

const CreateBody = z.object({
  title: z.string().max(300).optional(),
  type_key: z.string().max(100).nullable().optional(),
  content_json: z.object({ type: z.literal("doc") }).passthrough().optional(),
});

/** POST /api/documents — create a document (the editor calls this on the first edit of a new document). */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid document." }, { status: 400 });
  const doc = await createDocument(caller.teamId, caller.agent, parsed.data as Parameters<typeof createDocument>[2]);
  return NextResponse.json({ document: doc }, { status: 201 });
}
