import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { ingestSource } from "@/lib/sources/ingest";
import { createSource, getSource, linkSource, listSources, targetFolder, toSummary, type SourceKind } from "@/lib/sources/store";
import { assertPublicHttpUrl, UrlSourceError } from "@/lib/sources/url-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // ingest runs in after() and shares this budget

const KINDS = new Set<SourceKind>(["file", "url", "note"]);

/**
 * GET /api/sources?folder=<id|root>&q=&document=<id>&ids=a,b&kind=
 * Lists the team's sources (newest first) without their extracted text.
 */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceRead);
  if (caller instanceof NextResponse) return caller;
  const p = new URL(req.url).searchParams;
  const kind = p.get("kind") as SourceKind | null;
  const ids = p.get("ids");
  const sources = await listSources(caller.teamId, {
    folder: p.get("folder") || undefined,
    query: p.get("q") ?? undefined,
    documentId: p.get("document") || undefined,
    ids: ids != null ? ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200) : undefined,
    kind: kind && KINDS.has(kind) ? kind : undefined,
    limit: Number(p.get("limit")) || undefined,
  });
  return NextResponse.json({ sources });
}

const Placement = {
  folder_id: z.string().uuid().nullable().optional(),
  /** Put the source in this document's folder and link it to the document. */
  document_id: z.string().uuid().nullable().optional(),
};

const PostBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().trim().min(1).max(2000), title: z.string().trim().max(300).optional(), ...Placement }),
  z.object({ kind: z.literal("note"), title: z.string().trim().min(1).max(300), text: z.string().min(1).max(500_000), ...Placement }),
]);

/** POST /api/sources — add a link or a note. Files go through /api/upload/presign instead. */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.sourceWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Add a web address, or a note with a title and text." }, { status: 400 });
  const body = parsed.data;

  let url: string | null = null;
  if (body.kind === "url") {
    try {
      url = (await assertPublicHttpUrl(body.url)).toString();
    } catch (error) {
      const message = error instanceof UrlSourceError ? error.message : "That link can't be added.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const target = await targetFolder(caller.teamId, caller.agent, { folderId: body.folder_id, documentId: body.document_id });
  if (!target.ok) {
    return NextResponse.json({ error: target.reason === "document_not_found" ? "Document not found." : "Folder not found." }, { status: 404 });
  }
  const created = await createSource(caller.teamId, caller.agent, {
    kind: body.kind,
    folder_id: target.folderId,
    title: body.title || null,
    url,
    extracted_text: body.kind === "note" ? body.text : null,
    mime: body.kind === "note" ? "text/plain" : null,
  });
  if (body.document_id) await linkSource(caller.teamId, caller.agent, body.document_id, created.id);

  const { teamId, agent } = caller;
  after(() => ingestSource(teamId, created.id, agent));
  const source = (await getSource(teamId, created.id)) ?? created;
  return NextResponse.json({ source: toSummary(source) }, { status: 201 });
}
