// Suggestions per document (phase4-spec.md §4.1): the rows of the suggestion
// table and the one suggestion_run row per document (the last generation's
// inputs hash, time and error).
//
// Every function first loads the document for the caller's team, so a
// document from another team behaves exactly like a missing one (null). That
// call also applies the document tables the foreign keys need; the suggestion
// tables follow with ensureSchema. Regeneration (applyGenerated) only ever
// inserts, refreshes or removes OPEN rows of its own origin: what the person
// added, dismissed or typed in themselves survives every regeneration.
//
// Without POSTGRES_URL (local development, tests) rows live in process memory,
// cleared by resetMemoryStore() (documents store) or resetSuggestionStore().

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { getDocument, isUuid, nowIso, onMemoryStoreReset } from "@/lib/documents/store";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { processMemory } from "@/lib/process-memory";
import {
  SUGGESTION_KINDS,
  SUGGESTION_ORIGINS,
  SUGGESTION_STATES,
  suggestionDedupeKey,
  type SuggestionActionRequest,
  type SuggestionKind,
  type SuggestionOrigin,
  type SuggestionRecord,
  type SuggestionState,
} from "./contract";
import { neededItem, type GeneratedItem } from "./diff";
import { SUGGESTION_SCHEMA } from "./schema";

const hasDb = () => !!process.env.POSTGRES_URL;
const schema = () => ensureSchema("suggestions", SUGGESTION_SCHEMA);
const iso = (v: unknown) => new Date(v as string).toISOString();

export type SuggestionRun = { document_id: string; inputs_hash: string; generated_at: string; error: string | null };

type Row = SuggestionRecord & { team_id: string; dedupe_key: string; created_by: string };

const memory = processMemory("suggestions", () => ({
  rows: new Map<string, Row>(),
  runs: new Map<string, SuggestionRun & { team_id: string }>(),
}));

/** Clears the in-memory suggestions (tests). resetMemoryStore() calls this too. */
export function resetSuggestionStore() {
  memory.rows.clear();
  memory.runs.clear();
}
onMemoryStoreReset(resetSuggestionStore);

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => ((list as readonly string[]).includes(String(v)) ? (v as T) : fallback);

function rowToRecord(r: Record<string, unknown>): SuggestionRecord {
  return {
    id: String(r.id),
    document_id: String(r.document_id),
    kind: oneOf(SUGGESTION_KINDS, r.kind, "source"),
    label: String(r.label ?? ""),
    reason: String(r.reason ?? ""),
    spec_ref: r.spec_ref == null ? null : String(r.spec_ref),
    url: r.url == null ? null : String(r.url),
    origin: oneOf(SUGGESTION_ORIGINS, r.origin, "type"),
    state: oneOf(SUGGESTION_STATES, r.state, "open"),
    source_id: r.source_id == null ? null : String(r.source_id),
    data_table_id: r.data_table_id == null ? null : String(r.data_table_id),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const strip = ({ team_id: _t, dedupe_key: _k, created_by: _c, ...rec }: Row): SuggestionRecord => (void _t, void _k, void _c, rec);

const byCreated = (a: SuggestionRecord, b: SuggestionRecord) => a.created_at.localeCompare(b.created_at) || a.label.localeCompare(b.label);

/** The document is the team's (and the suggestion tables exist). */
async function canTouch(teamId: string, documentId: string): Promise<boolean> {
  if (!isUuid(documentId)) return false;
  if (!(await getDocument(teamId, documentId))) return false;
  await schema();
  return true;
}

/** Only http(s) links are ever stored (phase4-spec.md §5). */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// --- Reads ---------------------------------------------------------------------

/** Every suggestion of the document (all states), oldest first; null when the document isn't the team's. */
export async function listSuggestions(teamId: string, documentId: string): Promise<SuggestionRecord[] | null> {
  if (!(await canTouch(teamId, documentId))) return null;
  if (!hasDb()) {
    return [...memory.rows.values()]
      .filter((r) => r.document_id === documentId && r.team_id === teamId)
      .map(strip)
      .sort(byCreated);
  }
  const { rows } = await sql`
    SELECT * FROM suggestion WHERE document_id = ${documentId} AND team_id = ${teamId} ORDER BY created_at, label`;
  return rows.map(rowToRecord);
}

/** One suggestion of the document; null when it or the document isn't the team's. */
export async function getSuggestion(teamId: string, documentId: string, id: string): Promise<SuggestionRecord | null> {
  if (!isUuid(id) || !(await canTouch(teamId, documentId))) return null;
  if (!hasDb()) {
    const r = memory.rows.get(id);
    return r && r.document_id === documentId && r.team_id === teamId ? strip(r) : null;
  }
  const { rows } = await sql`SELECT * FROM suggestion WHERE id = ${id} AND document_id = ${documentId} AND team_id = ${teamId}`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * A fresh read of a source replaced table `fromId` with `toId` (the data
 * store's replaceSourceTables moves the document links the same way): data
 * suggestions the old table covered now name the new one, so "Covered by" and
 * the link check keep working.
 */
export async function retargetSuggestionTable(teamId: string, fromId: string, toId: string): Promise<void> {
  if (!isUuid(fromId) || !isUuid(toId)) return;
  if (!hasDb()) {
    for (const [id, r] of memory.rows) if (r.team_id === teamId && r.data_table_id === fromId) memory.rows.set(id, { ...r, data_table_id: toId });
    return;
  }
  await schema();
  await sql`UPDATE suggestion SET data_table_id = ${toId} WHERE data_table_id = ${fromId} AND team_id = ${teamId}`;
}

/** The document's last generation, or null (none yet, or not the team's document). */
export async function getRun(teamId: string, documentId: string): Promise<SuggestionRun | null> {
  if (!(await canTouch(teamId, documentId))) return null;
  if (!hasDb()) {
    const r = memory.runs.get(documentId);
    if (!r || r.team_id !== teamId) return null;
    const { team_id: _t, ...run } = r;
    void _t;
    return run;
  }
  const { rows } = await sql`SELECT * FROM suggestion_run WHERE document_id = ${documentId} AND team_id = ${teamId}`;
  const r = rows[0];
  return r ? { document_id: String(r.document_id), inputs_hash: String(r.inputs_hash), generated_at: iso(r.generated_at), error: r.error == null ? null : String(r.error) } : null;
}

/** Record a generation (its inputs hash, when, and the error if it failed). */
export async function setRun(teamId: string, documentId: string, run: { inputs_hash: string; generated_at: string; error: string | null }): Promise<SuggestionRun | null> {
  if (!(await canTouch(teamId, documentId))) return null;
  const error = run.error ? run.error.slice(0, 500) : null;
  if (!hasDb()) {
    const next = { document_id: documentId, team_id: teamId, inputs_hash: run.inputs_hash, generated_at: run.generated_at, error };
    memory.runs.set(documentId, next);
    return { document_id: documentId, inputs_hash: next.inputs_hash, generated_at: next.generated_at, error };
  }
  await sql`
    INSERT INTO suggestion_run (document_id, team_id, inputs_hash, generated_at, error)
    VALUES (${documentId}, ${teamId}, ${run.inputs_hash}, ${run.generated_at}, ${error})
    ON CONFLICT (document_id) DO UPDATE SET
      inputs_hash = EXCLUDED.inputs_hash, generated_at = EXCLUDED.generated_at, error = EXCLUDED.error`;
  return { document_id: documentId, inputs_hash: run.inputs_hash, generated_at: run.generated_at, error };
}

// --- Writes by the person ------------------------------------------------------

async function insertRow(row: Row): Promise<SuggestionRecord | null> {
  if (!hasDb()) {
    memory.rows.set(row.id, row);
    return strip(row);
  }
  const { rows } = await sql`
    INSERT INTO suggestion (id, team_id, document_id, kind, label, reason, spec_ref, url, origin, state, dedupe_key, source_id, data_table_id, created_by, created_at, updated_at)
    VALUES (${row.id}, ${row.team_id}, ${row.document_id}, ${row.kind}, ${row.label}, ${row.reason}, ${row.spec_ref}, ${row.url}, ${row.origin},
            ${row.state}, ${row.dedupe_key}, ${row.source_id}, ${row.data_table_id}, ${row.created_by}, now(), now())
    ON CONFLICT (document_id, dedupe_key) DO NOTHING
    RETURNING *`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

async function findByKey(teamId: string, documentId: string, key: string): Promise<SuggestionRecord | null> {
  if (!hasDb()) {
    const r = [...memory.rows.values()].find((x) => x.document_id === documentId && x.team_id === teamId && x.dedupe_key === key);
    return r ? strip(r) : null;
  }
  const { rows } = await sql`SELECT * FROM suggestion WHERE document_id = ${documentId} AND team_id = ${teamId} AND dedupe_key = ${key}`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

type Change = { state?: SuggestionState; source_id?: string | null; data_table_id?: string | null; reason?: string; spec_ref?: string | null; url?: string | null; origin?: SuggestionOrigin };

async function updateRow(teamId: string, documentId: string, id: string, c: Change): Promise<SuggestionRecord | null> {
  if (!hasDb()) {
    const prev = memory.rows.get(id);
    if (!prev || prev.document_id !== documentId || prev.team_id !== teamId) return null;
    const next: Row = { ...prev, ...c, updated_at: nowIso() };
    memory.rows.set(id, next);
    return strip(next);
  }
  // COALESCE can't tell "leave alone" from "set null", so each nullable column carries a flag.
  const { rows } = await sql`
    UPDATE suggestion SET
      state = COALESCE(${c.state ?? null}, state),
      source_id = CASE WHEN ${c.source_id !== undefined} THEN ${c.source_id ?? null}::uuid ELSE source_id END,
      data_table_id = CASE WHEN ${c.data_table_id !== undefined} THEN ${c.data_table_id ?? null}::uuid ELSE data_table_id END,
      reason = COALESCE(${c.reason ?? null}, reason),
      spec_ref = CASE WHEN ${c.spec_ref !== undefined} THEN ${c.spec_ref ?? null} ELSE spec_ref END,
      url = CASE WHEN ${c.url !== undefined} THEN ${c.url ?? null} ELSE url END,
      origin = COALESCE(${c.origin ?? null}, origin),
      updated_at = now()
    WHERE id = ${id} AND document_id = ${documentId} AND team_id = ${teamId}
    RETURNING *`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * The person adds their own item (origin "user", open). A label that matches an
 * existing suggestion returns that row instead (`created: false`), restored to
 * open if it had been dismissed. Null when the document isn't the team's.
 */
export async function createUserSuggestion(
  teamId: string,
  agent: string,
  documentId: string,
  input: { kind: "source" | "data"; label: string; reason?: string },
): Promise<{ suggestion: SuggestionRecord; created: boolean } | null> {
  if (!(await canTouch(teamId, documentId))) return null;
  const item = neededItem(input.kind, input.label, input.reason ?? "", null);
  const existing = await findByKey(teamId, documentId, item.dedupe_key);
  if (existing) {
    if (existing.state !== "dismissed") return { suggestion: existing, created: false };
    const restored = await updateRow(teamId, documentId, existing.id, { state: "open", source_id: null, data_table_id: null });
    return restored ? { suggestion: restored, created: false } : null;
  }
  const at = nowIso();
  const row: Row = {
    id: randomUUID(),
    team_id: teamId,
    document_id: documentId,
    kind: item.kind,
    label: item.label,
    reason: item.reason,
    spec_ref: null,
    url: null,
    origin: "user",
    state: "open",
    dedupe_key: item.dedupe_key,
    source_id: null,
    data_table_id: null,
    created_by: agent,
    created_at: at,
    updated_at: at,
  };
  const inserted = await insertRow(row);
  if (inserted) return { suggestion: inserted, created: true };
  // Lost a race with a concurrent insert of the same label: return that row.
  const raced = await findByKey(teamId, documentId, item.dedupe_key);
  return raced ? { suggestion: raced, created: false } : null;
}

/**
 * Add, dismiss or restore one suggestion. "add" marks it added: a source/web
 * item with the linked source, a data item with the data table linked for it
 * (or just "noted" without one). "dismiss" hides it and "restore" reopens it;
 * both forget the source and the table.
 */
export async function setSuggestionState(
  teamId: string,
  documentId: string,
  id: string,
  action: SuggestionActionRequest["action"],
  sourceId?: string | null,
  dataTableId?: string | null,
): Promise<SuggestionRecord | null> {
  const current = await getSuggestion(teamId, documentId, id);
  if (!current) return null;
  const change: Change =
    action === "add"
      ? current.kind === "data"
        ? { state: "added", source_id: null, data_table_id: dataTableId ?? current.data_table_id ?? null }
        : { state: "added", source_id: sourceId ?? current.source_id ?? null }
      : action === "dismiss"
        ? { state: "dismissed", source_id: null, data_table_id: null }
        : { state: "open", source_id: null, data_table_id: null };
  return updateRow(teamId, documentId, id, change);
}

// --- Regeneration ----------------------------------------------------------------

/** Only a data item can be covered by a data table. */
const coveringTable = (item: GeneratedItem): string | null => (item.kind === "data" ? (item.covered_by_table ?? null) : null);

export type ApplyPlan = {
  insert: Array<GeneratedItem & { dedupe_key: string }>;
  update: Array<{ id: string; change: Change }>;
  remove: string[];
};

/**
 * What a generation for `origin` changes, given the document's current rows:
 * - a new item is inserted open, or added with its source (or, for a data
 *   item, its data table) when covered;
 * - an existing OPEN row (not the person's own) gets the fresh reason,
 *   spec_ref and url, takes this origin, and becomes added when now covered;
 *   the person's own open rows only become added when covered;
 * - added and dismissed rows are never changed;
 * - open rows of this origin that are no longer proposed are removed.
 */
export function planApply(existing: Array<Pick<SuggestionRecord, "id" | "kind" | "label" | "origin" | "state" | "reason" | "spec_ref" | "url">>, origin: SuggestionOrigin, items: GeneratedItem[]): ApplyPlan {
  const byKey = new Map(existing.map((r) => [suggestionDedupeKey(r.kind, r.label), r]));
  const proposed = new Set<string>();
  const plan: ApplyPlan = { insert: [], update: [], remove: [] };
  for (const raw of items) {
    const item = { ...neededItem(raw.kind, raw.label, raw.reason, raw.spec_ref), url: safeUrl(raw.url), covered_by: raw.covered_by ?? null, covered_by_table: coveringTable(raw) };
    if (!item.label || proposed.has(item.dedupe_key)) continue;
    proposed.add(item.dedupe_key);
    const row = byKey.get(item.dedupe_key);
    if (!row) {
      plan.insert.push(item);
      continue;
    }
    if (row.state !== "open") continue;
    const covered: Change = item.covered_by_table
      ? { state: "added", source_id: null, data_table_id: item.covered_by_table }
      : item.covered_by
        ? { state: "added", source_id: item.covered_by }
        : {};
    if (row.origin === "user") {
      if (covered.state) plan.update.push({ id: row.id, change: covered });
      continue;
    }
    const change: Change = { ...covered };
    if (row.reason !== item.reason) change.reason = item.reason;
    if (row.spec_ref !== item.spec_ref) change.spec_ref = item.spec_ref;
    if (item.url !== null && row.url !== item.url) change.url = item.url;
    if (row.origin !== origin) change.origin = origin;
    if (Object.keys(change).length) plan.update.push({ id: row.id, change });
  }
  for (const r of existing) {
    if (r.origin === origin && r.origin !== "user" && r.state === "open" && !proposed.has(suggestionDedupeKey(r.kind, r.label))) plan.remove.push(r.id);
  }
  return plan;
}

/**
 * Write one origin's generated items (see planApply). Returns the document's
 * whole list afterwards; null when the document isn't the team's.
 */
export async function applyGenerated(teamId: string, agent: string, documentId: string, origin: SuggestionOrigin, items: GeneratedItem[]): Promise<SuggestionRecord[] | null> {
  const existing = await listSuggestions(teamId, documentId);
  if (!existing) return null;
  const plan = planApply(existing, origin, items);
  for (const item of plan.insert) {
    const at = nowIso();
    await insertRow({
      id: randomUUID(),
      team_id: teamId,
      document_id: documentId,
      kind: item.kind as SuggestionKind,
      label: item.label,
      reason: item.reason,
      spec_ref: item.spec_ref,
      url: item.url ?? null,
      origin,
      state: item.covered_by || item.covered_by_table ? "added" : "open",
      dedupe_key: item.dedupe_key,
      source_id: item.covered_by_table ? null : (item.covered_by ?? null),
      data_table_id: item.covered_by_table ?? null,
      created_by: agent,
      created_at: at,
      updated_at: at,
    });
  }
  for (const { id, change } of plan.update) await updateRow(teamId, documentId, id, change);
  if (plan.remove.length) {
    if (!hasDb()) {
      for (const id of plan.remove) memory.rows.delete(id);
    } else {
      // Re-checked in SQL so a row the person acted on meanwhile is kept.
      await sql.query(`DELETE FROM suggestion WHERE document_id = $1 AND team_id = $2 AND state = 'open' AND origin = $3 AND id = ANY($4::uuid[])`, [
        documentId,
        teamId,
        origin,
        plan.remove,
      ]);
    }
  }
  return listSuggestions(teamId, documentId);
}
