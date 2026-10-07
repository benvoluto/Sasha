// Document-level flags a person sets: whether the document is archived, and the
// summary note they've written over the generated one.
//
// Both live on the group's metadata.json alongside the extraction record, so a
// document carries its own state rather than needing a second store. Writes are
// read-modify-write against the same blob the rest of the pipeline uses.

import { list, put } from "@vercel/blob";
import { fetchGroupMetadata } from "./group-metadata";

export type ArchiveRecord = { at: string; by?: string };

/**
 * A human-authored replacement for the generated summary.
 *
 * `basedOn` records the generated text that was on screen when the person
 * edited. Comparing it to the current generated summary is how the UI knows the
 * document has moved on since they wrote this — without ever overwriting their
 * words to tell them so.
 */
export type SummaryNote = {
  text: string;
  editedAt: string;
  editedBy?: string;
  basedOn?: string;
};

export type CaseFlags = {
  archived?: ArchiveRecord;
  summaryNote?: SummaryNote;
};

/** Merge a partial update into the group's metadata.json. Returns false if absent. */
async function patchMetadata(groupId: string, patch: Record<string, unknown>): Promise<boolean> {
  const meta = (await fetchGroupMetadata(groupId)) as Record<string, unknown> | null;
  if (!meta) return false;
  const merged = { ...meta, ...patch };
  const { blobs } = await list({ prefix: `upload-groups/${groupId}/` });
  const found = blobs.find((b) => b.pathname.endsWith("/metadata.json"));
  const pathname = found?.pathname ?? `upload-groups/${groupId}/metadata.json`;
  await put(pathname, JSON.stringify(merged), { access: "public", contentType: "application/json", allowOverwrite: true });
  return true;
}

/**
 * Archive or restore a document.
 *
 * Archiving is deliberately reversible and non-destructive: nothing is deleted,
 * the document simply leaves the working list. Deleting finished work should
 * take more than one click on a button labelled "Archive".
 */
export async function setArchived(groupId: string, archived: boolean, by?: string): Promise<boolean> {
  return patchMetadata(groupId, {
    archived: archived ? ({ at: new Date().toISOString(), ...(by ? { by } : {}) } satisfies ArchiveRecord) : undefined,
  });
}

/** Save (or clear, with null) the person's own summary note. */
export async function setSummaryNote(
  groupId: string,
  text: string | null,
  opts: { by?: string; basedOn?: string } = {},
): Promise<boolean> {
  const trimmed = text?.trim();
  return patchMetadata(groupId, {
    summaryNote: trimmed
      ? ({
          text: trimmed,
          editedAt: new Date().toISOString(),
          ...(opts.by ? { editedBy: opts.by } : {}),
          ...(opts.basedOn ? { basedOn: opts.basedOn } : {}),
        } satisfies SummaryNote)
      : undefined,
  });
}

export function isArchived(meta: { archived?: unknown } | null | undefined): boolean {
  return !!meta?.archived;
}

/**
 * What the sticky note should show, and whether it has fallen behind.
 *
 * A person's edit is never replaced by a later generation — it is only ever
 * flagged as out of date, leaving the decision to regenerate with them.
 */
export function resolveNote(
  note: SummaryNote | undefined,
  generated: string | undefined,
): { text: string; edited: boolean; stale: boolean } {
  if (note?.text) {
    const stale = !!generated && !!note.basedOn && generated.trim() !== note.basedOn.trim();
    return { text: note.text, edited: true, stale };
  }
  return { text: generated ?? "", edited: false, stale: false };
}
