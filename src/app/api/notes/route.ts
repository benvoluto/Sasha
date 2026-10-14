import { NextResponse } from "next/server";
import { listDocumentNotes } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { CreateNoteBody, NOTES_FEED_LIMIT, type NoteResponse, type NotesFeedResponse } from "@/lib/notes/contract";
import { notesFeed } from "@/lib/notes/feed";
import { createNote, listNotes } from "@/lib/notes/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/notes?q= — standalone notes and documents' notes, newest first (redesign3-spec.md §7). */
export async function GET(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const query = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  const [notes, documents] = await Promise.all([
    listNotes(caller.teamId, { query, limit: NOTES_FEED_LIMIT }),
    listDocumentNotes(caller.teamId, { query, limit: NOTES_FEED_LIMIT }),
  ]);
  return NextResponse.json({ items: notesFeed(notes, documents) } satisfies NotesFeedResponse);
}

/** POST /api/notes — a new standalone note (the New note card posts an empty body). */
export async function POST(req: Request) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const parsed = CreateNoteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid note." }, { status: 400 });
  const note = await createNote(caller.teamId, caller.agent, parsed.data.body);
  return NextResponse.json({ note } satisfies NoteResponse, { status: 201 });
}
