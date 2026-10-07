// The team's edits to a document's suggested sources and data, in
// Postgres. Not on the metadata blob: a blob overwrite can take up to a
// minute to read back, so two quick edits (dismiss, then add) lost the first.
// Without POSTGRES_URL they live in process memory.

import { sql } from "@vercel/postgres";
import { applyAction, editsOf, emptyEdits, type SuggestionAction, type SuggestionEdits, type SuggestionKind } from "@/lib/case-suggestions";
import { ensureSchema } from "./ensure-schema";

export const SUGGESTION_EDITS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS case_suggestion_edits (
     group_id TEXT PRIMARY KEY, edits JSONB NOT NULL,
     updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
];

const memory = new Map<string, SuggestionEdits>();
const hasDb = () => !!process.env.POSTGRES_URL;

export async function getSuggestionEdits(groupId: string): Promise<SuggestionEdits> {
  if (!hasDb()) return memory.get(groupId) ?? emptyEdits();
  await ensureSchema("suggestion-edits", SUGGESTION_EDITS_SCHEMA);
  const { rows } = await sql`SELECT edits FROM case_suggestion_edits WHERE group_id = ${groupId}`;
  return rows[0] ? editsOf({ suggestionEdits: rows[0].edits }) : emptyEdits();
}

export async function applySuggestionEdit(groupId: string, kind: SuggestionKind, action: SuggestionAction, name: string, by: string): Promise<SuggestionEdits> {
  const next = applyAction(await getSuggestionEdits(groupId), kind, action, name);
  if (!hasDb()) {
    memory.set(groupId, next);
    return next;
  }
  await sql`INSERT INTO case_suggestion_edits (group_id, edits, updated_by) VALUES (${groupId}, ${JSON.stringify(next)}::jsonb, ${by})
            ON CONFLICT (group_id) DO UPDATE SET edits = EXCLUDED.edits, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return next;
}
