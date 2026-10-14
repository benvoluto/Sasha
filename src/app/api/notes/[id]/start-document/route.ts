import { NextResponse } from "next/server";
import { createDocument } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { noteTitle, type StartDocumentResponse } from "@/lib/notes/contract";
import { restoreNote, takeNote } from "@/lib/notes/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/notes/[id]/start-document — an untyped document whose notes are
 * the note's body, titled by its first line. The note is removed as it is
 * read, so it shows only as the document's notes and two requests for it (two
 * teammates, or a retry) can't both make a document; it is put back if the
 * document can't be created.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const id = (await params).id;
  const note = await takeNote(caller.teamId, id);
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });
  let doc;
  try {
    doc = await createDocument(caller.teamId, caller.agent, { title: noteTitle(note.body), notes: note.body });
  } catch (err) {
    await restoreNote(caller.teamId, note);
    throw err;
  }
  return NextResponse.json({ document: { id: doc.id, title: doc.title } } satisfies StartDocumentResponse, { status: 201 });
}
