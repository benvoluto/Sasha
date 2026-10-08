// The classifier's writes to a document (phase4-spec.md §1.1): only
// type_confidence, last_classified_at and classifier_state change, and
// updated_at / updated_by never do, so a classifier run or a "Not now" can't
// make the editor's next save look like a teammate's edit (409).
//
// Postgres: one UPDATE of those columns. Memory: the record in
// memoryDocuments() is replaced with a spread copy.

import { sql } from "@vercel/postgres";
import { getDocument, memoryDocuments, type DocumentRecord } from "@/lib/documents/store";
import type { ClassifierState, ClassifierView } from "./contract";

const hasDb = () => !!process.env.POSTGRES_URL;

export type ClassifierFields = {
  type_confidence?: number | null;
  last_classified_at?: string;
  classifier_state?: ClassifierState;
};

/** The classifier's view of a document (GET/POST /classify and the dismiss route). */
export function classifierView(doc: DocumentRecord): ClassifierView {
  return {
    type_key: doc.type_key,
    type_source: doc.type_source,
    type_confidence: doc.type_confidence,
    last_classified_at: doc.last_classified_at,
    state: doc.classifier_state,
  };
}

/** Write the given classifier fields; null when the document isn't the team's. */
export async function writeClassifierFields(teamId: string, id: string, fields: ClassifierFields): Promise<DocumentRecord | null> {
  const current = await getDocument(teamId, id);
  if (!current) return null;
  const next: DocumentRecord = {
    ...current,
    ...(fields.type_confidence !== undefined ? { type_confidence: fields.type_confidence } : {}),
    ...(fields.last_classified_at !== undefined ? { last_classified_at: new Date(fields.last_classified_at).toISOString() } : {}),
    ...(fields.classifier_state !== undefined ? { classifier_state: fields.classifier_state } : {}),
  };
  if (!hasDb()) {
    const docs = memoryDocuments();
    const latest = docs.get(id);
    if (!latest || latest.team_id !== teamId) return null;
    // Re-read: only the classifier's own columns come from `next`.
    const merged: DocumentRecord = {
      ...latest,
      type_confidence: next.type_confidence,
      last_classified_at: next.last_classified_at,
      classifier_state: next.classifier_state,
    };
    docs.set(id, merged);
    return merged;
  }
  const setConfidence = fields.type_confidence !== undefined;
  const setAt = fields.last_classified_at !== undefined;
  const setState = fields.classifier_state !== undefined;
  const { rowCount } = await sql`
    UPDATE document SET
      type_confidence = CASE WHEN ${setConfidence} THEN ${next.type_confidence}::real ELSE type_confidence END,
      last_classified_at = CASE WHEN ${setAt} THEN ${next.last_classified_at}::timestamptz ELSE last_classified_at END,
      classifier_state = CASE WHEN ${setState} THEN ${JSON.stringify(next.classifier_state)}::jsonb ELSE classifier_state END
    WHERE id = ${id} AND team_id = ${teamId}`;
  if (!rowCount) return null;
  return getDocument(teamId, id);
}

/** "Not now" for `key`: count it and clear the last result (the chip hides until the next run). */
export async function dismissType(teamId: string, id: string, key: string): Promise<DocumentRecord | null> {
  const doc = await getDocument(teamId, id);
  if (!doc) return null;
  const state = doc.classifier_state;
  return writeClassifierFields(teamId, id, {
    classifier_state: { ...state, last: null, dismissals: { ...state.dismissals, [key]: (state.dismissals[key] ?? 0) + 1 } },
  });
}
