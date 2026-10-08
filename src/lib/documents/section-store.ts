// Per-section metadata (the document_section table): the writer's notes for a
// section, its drafting status and when Claude last drafted it. Rows are keyed
// by (document_id, section_id), where section_id is the heading's stable
// `sectionId` attribute, so notes follow a section when text moves around.
//
// The table has no team_id: every function first loads the document for the
// caller's team, and a document from another team behaves exactly like a
// missing one (null). Notes are saved here, never through the whole-document
// autosave, so a notes save and a body save can't trip each other's
// `updated_at` check.
//
// Without POSTGRES_URL (local development, tests) rows live in process memory,
// cleared by resetMemoryStore() or resetSectionStore().

import { sql } from "@vercel/postgres";
import { SECTION_STATUSES, SectionId, type SectionMeta, type SectionStatus } from "@/lib/sections/contract";
import { getDocument, isUuid, onMemoryStoreReset } from "./store";
import { processMemory } from "@/lib/process-memory";

const hasDb = () => !!process.env.POSTGRES_URL;
const iso = (v: unknown) => new Date(v as string).toISOString();

const memory = processMemory("sections", () => new Map<string, SectionMeta & { document_id: string }>());
const memKey = (documentId: string, sectionId: string) => `${documentId}:${sectionId}`;

/** Clears the in-memory section rows (tests). resetMemoryStore() calls this too. */
export function resetSectionStore() {
  memory.clear();
}
onMemoryStoreReset(resetSectionStore);

let lastStamp = 0;
function nowIso(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/** What a section with no stored row reads as. */
export function blankSectionMeta(sectionId: string, specKey: string | null = null): SectionMeta {
  return { section_id: sectionId, spec_key: specKey, notes: "", status: "empty", last_generated_at: null, updated_at: new Date(0).toISOString() };
}

function toStatus(v: unknown): SectionStatus {
  return (SECTION_STATUSES as readonly string[]).includes(String(v)) ? (v as SectionStatus) : "empty";
}

function rowToMeta(r: Record<string, unknown>): SectionMeta {
  return {
    section_id: String(r.section_id),
    spec_key: r.spec_key == null ? null : String(r.spec_key),
    notes: String(r.notes ?? ""),
    status: toStatus(r.status),
    last_generated_at: r.last_generated_at == null ? null : iso(r.last_generated_at),
    updated_at: r.updated_at == null ? new Date(0).toISOString() : iso(r.updated_at),
  };
}

const strip = ({ document_id: _d, ...m }: SectionMeta & { document_id: string }): SectionMeta => (void _d, m);

/** The document is the team's and the section id is well formed. */
async function canTouch(teamId: string, documentId: string, sectionId?: string): Promise<boolean> {
  if (!isUuid(documentId)) return false;
  if (sectionId !== undefined && !SectionId.safeParse(sectionId).success) return false;
  return !!(await getDocument(teamId, documentId));
}

/** Every stored row for the document, by section id; null when the document isn't the team's. */
export async function listSectionMeta(teamId: string, documentId: string): Promise<SectionMeta[] | null> {
  if (!(await canTouch(teamId, documentId))) return null;
  if (!hasDb()) {
    return [...memory.values()]
      .filter((m) => m.document_id === documentId)
      .map(strip)
      .sort((a, b) => a.section_id.localeCompare(b.section_id));
  }
  const { rows } = await sql`
    SELECT section_id, spec_key, notes, status, last_generated_at, updated_at
      FROM document_section WHERE document_id = ${documentId} ORDER BY section_id`;
  return rows.map(rowToMeta);
}

/** One section's row, or a blank one when it has none; null when the document isn't the team's. */
export async function getSectionMeta(teamId: string, documentId: string, sectionId: string): Promise<SectionMeta | null> {
  if (!(await canTouch(teamId, documentId, sectionId))) return null;
  if (!hasDb()) {
    const m = memory.get(memKey(documentId, sectionId));
    return m ? strip(m) : blankSectionMeta(sectionId);
  }
  const { rows } = await sql`
    SELECT section_id, spec_key, notes, status, last_generated_at, updated_at
      FROM document_section WHERE document_id = ${documentId} AND section_id = ${sectionId}`;
  return rows[0] ? rowToMeta(rows[0]) : blankSectionMeta(sectionId);
}

/**
 * Save a section's notes (creating the row if needed). The status is kept.
 * `specKey` undefined keeps the stored one; null clears it.
 */
export async function putSectionNotes(
  teamId: string,
  documentId: string,
  sectionId: string,
  input: { notes: string; specKey?: string | null },
): Promise<SectionMeta | null> {
  if (!(await canTouch(teamId, documentId, sectionId))) return null;
  const setSpec = input.specKey !== undefined;
  const specKey = input.specKey ?? null;
  if (!hasDb()) {
    const k = memKey(documentId, sectionId);
    const prev = memory.get(k) ?? { ...blankSectionMeta(sectionId), document_id: documentId };
    const next = { ...prev, notes: input.notes, spec_key: setSpec ? specKey : prev.spec_key, updated_at: nowIso() };
    memory.set(k, next);
    return strip(next);
  }
  const { rows } = await sql`
    INSERT INTO document_section (document_id, section_id, spec_key, notes, status, updated_at)
    VALUES (${documentId}, ${sectionId}, ${specKey}, ${input.notes}, 'empty', now())
    ON CONFLICT (document_id, section_id) DO UPDATE SET
      notes = EXCLUDED.notes,
      spec_key = CASE WHEN ${setSpec} THEN EXCLUDED.spec_key ELSE document_section.spec_key END,
      updated_at = now()
    RETURNING section_id, spec_key, notes, status, last_generated_at, updated_at`;
  return rowToMeta(rows[0]);
}

/** Record a Claude draft of the section: status "drafted", last_generated_at now. Notes are kept. */
export async function markSectionGenerated(teamId: string, documentId: string, sectionId: string, specKey: string | null): Promise<SectionMeta | null> {
  if (!(await canTouch(teamId, documentId, sectionId))) return null;
  if (!hasDb()) {
    const k = memKey(documentId, sectionId);
    const prev = memory.get(k) ?? { ...blankSectionMeta(sectionId), document_id: documentId };
    const now = nowIso();
    const next = { ...prev, spec_key: specKey ?? prev.spec_key, status: "drafted" as const, last_generated_at: now, updated_at: now };
    memory.set(k, next);
    return strip(next);
  }
  const { rows } = await sql`
    INSERT INTO document_section (document_id, section_id, spec_key, status, last_generated_at, updated_at)
    VALUES (${documentId}, ${sectionId}, ${specKey}, 'drafted', now(), now())
    ON CONFLICT (document_id, section_id) DO UPDATE SET
      spec_key = COALESCE(EXCLUDED.spec_key, document_section.spec_key),
      status = 'drafted', last_generated_at = now(), updated_at = now()
    RETURNING section_id, spec_key, notes, status, last_generated_at, updated_at`;
  return rowToMeta(rows[0]);
}
