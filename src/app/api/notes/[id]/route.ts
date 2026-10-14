import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/documents/team";
import { UpdateNoteBody, type DeleteNoteResponse, type NoteConflictResponse, type NoteResponse } from "@/lib/notes/contract";
import { deleteNote, getNote, updateNote } from "@/lib/notes/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "Note not found." }, { status: 404 });

/** GET /api/notes/[id] */
export async function GET(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const note = await getNote(caller.teamId, (await params).id);
  if (!note) return notFound();
  return NextResponse.json({ note } satisfies NoteResponse);
}

/** PATCH /api/notes/[id] — save the body. A stale `base_updated_at` answers 409 with the current note. */
export async function PATCH(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  // Invalid JSON fails the parse (never defaulted), so it can't blank the note.
  const parsed = UpdateNoteBody.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "Invalid note." }, { status: 400 });
  const result = await updateNote(caller.teamId, (await params).id, caller.agent, parsed.data.body, parsed.data.base_updated_at);
  if (!result) return notFound();
  if (!result.ok) {
    return NextResponse.json({ error: "Someone else changed this note.", code: "conflict", note: result.conflict } satisfies NoteConflictResponse, { status: 409 });
  }
  return NextResponse.json({ note: result.note } satisfies NoteResponse);
}

/** DELETE /api/notes/[id] */
export async function DELETE(_req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  if (!(await deleteNote(caller.teamId, (await params).id))) return notFound();
  return NextResponse.json({ deleted: true } satisfies DeleteNoteResponse);
}
