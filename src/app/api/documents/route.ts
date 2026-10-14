import { NextResponse } from "next/server";
import { z } from "zod";
import { getType } from "@/catalog";
import { outlineDoc } from "@/catalog/outline";
import { DocumentListFolderParam } from "@/lib/documents/folders-contract";
import { MAX_DOCUMENT_NOTES } from "@/lib/documents/notes-contract";
import { createDocument, listDocuments, type DocumentInit } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const dynamic = "force-dynamic";

/** Most documents one GET may ask for (`limit`, 1–500; the store's default is 100). */
const LIST_LIMIT_MAX = 500;

/**
 * GET /api/documents?q=&archived=1&folder=root|<uuid>&limit= — the team's
 * documents, newest first. `folder` omitted lists every folder (search, the
 * archived view). The overview asks for up to 200 (`limit`).
 */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const url = new URL(req.url);
  const folderParam = url.searchParams.get("folder");
  let folder: string | undefined;
  if (folderParam !== null) {
    const parsed = DocumentListFolderParam.safeParse(folderParam);
    if (!parsed.success) return NextResponse.json({ error: "Invalid folder." }, { status: 400 });
    folder = parsed.data.toLowerCase();
  }
  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) return NextResponse.json({ error: "Invalid limit." }, { status: 400 });
  }
  const documents = await listDocuments(caller.teamId, {
    query: url.searchParams.get("q") ?? "",
    archived: url.searchParams.get("archived") === "1",
    folder,
    limit,
  });
  return NextResponse.json({ documents });
}

const CreateBody = z.object({
  title: z.string().max(300).optional(),
  type_key: z.string().max(100).nullable().optional(),
  content_json: z.object({ type: z.literal("doc") }).passthrough().optional(),
  notes: z.string().max(MAX_DOCUMENT_NOTES).optional(),
});

/**
 * POST /api/documents — create a document. The editor calls this on the first
 * edit of a new document (with its body), and "New document of type" calls it
 * with only `type_key`: the body is then the type's outline (one heading per
 * section, with scaffolds), and the canonical key is stored for an alias.
 */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid document." }, { status: 400 });
  const init: DocumentInit = { ...(parsed.data as DocumentInit) };
  if (parsed.data.type_key && !parsed.data.content_json) {
    const entry = await getType(caller.teamId, parsed.data.type_key);
    if (!entry || !entry.enabled) return NextResponse.json({ error: "Unknown document type." }, { status: 400 });
    init.type_key = entry.definition.key;
    init.content_json = outlineDoc(entry.definition.sections);
  }
  const doc = await createDocument(caller.teamId, caller.agent, init);
  return NextResponse.json({ document: doc }, { status: 201 });
}
