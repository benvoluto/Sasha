// Data tables per source and their links to documents (phase5-spec.md §1–2).
//
// A table belongs to a team and to the source it was read from; `team_id` is
// on every table and link so each query scopes to the team without a join, and
// a table, source or document of another team behaves exactly like a missing
// one. Rows live in data_row (paged, never loaded with the table) and a
// person's cell edits in data_cell_override (the current value plus the
// source's original). Every person's change is written to the audit log;
// a failed audit write is logged and never fails the change.
//
// A fresh read of a source (replaceSourceTables) supersedes its earlier tables
// and hands each old table's document links to the new table with the same
// match_key. Deleting a source cascades its tables in Postgres; in memory,
// every read checks the source (getSource) and the linked documents
// (getDocument) and prunes what is gone, which gives the same behaviour
// without hooks into those stores.
//
// Without POSTGRES_URL (local development, tests) everything lives in process
// memory, cleared by resetMemoryStore() (documents store) or resetDataStore().

import { randomUUID } from "node:crypto";
import { sql } from "@vercel/postgres";
import { DOCUMENT_SCHEMA, getDocument, isUuid, nowIso, onMemoryStoreReset } from "@/lib/documents/store";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { defaultAuditSink } from "@/lib/ontology/governance";
import { processMemory } from "@/lib/process-memory";
import { getSource, listDocumentSources, SOURCE_SCHEMA, type SourceRecord } from "@/lib/sources/store";
import { retargetSuggestionTable } from "@/lib/suggestions/store";
import {
  COLUMN_TYPES,
  EXTRACTION_METHODS,
  MAX_LABEL_CHARS,
  MAX_TABLE_ROWS,
  MAX_TABLES_PER_SOURCE,
  TABLE_STATUSES,
  type Cell,
  type CellOverride,
  type DataColumn,
  type DataRow,
  type DataTablePatch,
  type DataTableSummary,
  type ExtractedTable,
  type ExtractionMethod,
  type LinkedDataTable,
  type PageRange,
  type TableStatus,
} from "./contract";
import { DATA_SCHEMA } from "./schema";

const hasDb = () => !!process.env.POSTGRES_URL;
// data_table references source and document_data references document, so their tables come first.
const schema = () => ensureSchema("data", [...DOCUMENT_SCHEMA, ...SOURCE_SCHEMA, ...DATA_SCHEMA]);

export type TableQuery = {
  sourceId?: string;
  /** Linked to this document. */
  documentId?: string;
  /** Read from a source linked to this document. */
  forDocument?: string;
  /** Default ["active"]. */
  status?: TableStatus[];
  /** Matches the table name, column labels, source title or filename. */
  query?: string;
  limit?: number;
};

export type ReplaceResult = { inserted: number; superseded: number };
export type ReplaceOptions = {
  /**
   * Pages the fresh read couldn't read (a chunk failed, or was past the cap):
   * earlier tables found on them stay as they are rather than being retired
   * with nothing to replace them.
   */
  keepPages?: PageRange[];
};

export type PatchResult =
  | { ok: true; table: DataTableSummary; row?: DataRow }
  | { ok: false; reason: "not_found" | "column_not_found" | "row_not_found" | "invalid_state" | "invalid_supersede" | "not_superseded" | "no_override" };

/** listTables returns at most this many. */
export const MAX_LIST_TABLES = 200;
/** data_row inserts go in batches of this many rows (one unnest per batch). */
export const ROW_INSERT_BATCH = 1000;

/** The table row without its joins (source, links, override count). */
type TableRow = Omit<DataTableSummary, "source" | "document_ids" | "override_count"> & { team_id: string; idx: number; match_key: string; created_by: string };
type LinkRow = { document_id: string; table_id: string; team_id: string; added_by: string; added_at: string };
type OverrideRow = { row_idx: number; col_key: string; value: Cell; original: Cell; created_by: string; created_at: string };

const iso = (v: unknown) => new Date(v as string).toISOString();
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => ((list as readonly string[]).includes(String(v)) ? (v as T) : fallback);

function parseColumns(v: unknown): DataColumn[] {
  const list = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(list)) return [];
  return list.map((c: Record<string, unknown>) => ({
    key: String(c.key),
    label: String(c.label ?? ""),
    type: oneOf(COLUMN_TYPES, c.type, "text"),
    inferred: oneOf(COLUMN_TYPES, c.inferred, "text"),
    unit: str(c.unit),
  }));
}

function parseCells(v: unknown): Cell[] {
  const list = typeof v === "string" ? JSON.parse(v) : v;
  return Array.isArray(list) ? list.map((c) => (c == null ? null : String(c))) : [];
}

function rowToTable(r: Record<string, unknown>): TableRow {
  return {
    id: String(r.id),
    team_id: String(r.team_id ?? ""),
    source_id: String(r.source_id),
    idx: Number(r.idx ?? 0),
    match_key: String(r.match_key ?? ""),
    name: String(r.name ?? ""),
    columns: parseColumns(r.columns),
    row_count: Number(r.row_count ?? 0),
    status: oneOf(TABLE_STATUSES, r.status, "active"),
    superseded_by: str(r.superseded_by),
    extraction_method: oneOf(EXTRACTION_METHODS, r.extraction_method, "csv"),
    sheet: str(r.sheet),
    page: num(r.page),
    page_end: num(r.page_end),
    confidence: num(r.confidence),
    notes: String(r.notes ?? ""),
    truncated: !!r.truncated,
    created_by: String(r.created_by ?? ""),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function toSummary(t: TableRow, source: DataTableSummary["source"], documentIds: string[], overrideCount: number): DataTableSummary {
  const { team_id: _t, idx: _i, match_key: _m, created_by: _c, ...rest } = t;
  void _t;
  void _i;
  void _m;
  void _c;
  return { ...rest, columns: rest.columns.map((c) => ({ ...c })), source, document_ids: documentIds, override_count: overrideCount };
}

/** A summary from a joined SQL row (SUMMARY_COLUMNS). */
function rowToSummary(r: Record<string, unknown>): DataTableSummary {
  const source = { id: String(r.source_id), title: str(r.source_title), filename: str(r.source_filename), kind: oneOf(["file", "url", "note"] as const, r.source_kind, "file"), mime: str(r.source_mime) };
  return toSummary(rowToTable(r), source, Array.isArray(r.document_ids) ? r.document_ids.map(String) : [], Number(r.override_count ?? 0));
}

const sourceOf = (s: SourceRecord): DataTableSummary["source"] => ({ id: s.id, title: s.title, filename: s.filename, kind: s.kind, mime: s.mime });

/** LIKE wildcards escaped, as in the sources store. */
const likePattern = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

// --- In-memory fallback -------------------------------------------------------

const memory = processMemory("data", () => ({
  tables: new Map<string, TableRow>(),
  rows: new Map<string, Cell[][]>(),
  /** By table id, then `${row}:${key}`. */
  overrides: new Map<string, Map<string, OverrideRow>>(),
  links: new Map<string, LinkRow>(),
}));

const linkKey = (documentId: string, tableId: string) => `${documentId}:${tableId}`;
const overrideKey = (row: number, key: string) => `${row}:${key}`;

/** Clears the in-memory store (tests). resetMemoryStore() calls this too. */
export function resetDataStore(): void {
  memory.tables.clear();
  memory.rows.clear();
  memory.overrides.clear();
  memory.links.clear();
}
onMemoryStoreReset(resetDataStore);

/** Forget a table whose source is gone (what the foreign-key cascade does in Postgres). */
function pruneTable(id: string) {
  memory.tables.delete(id);
  memory.rows.delete(id);
  memory.overrides.delete(id);
  for (const [k, l] of memory.links) if (l.table_id === id) memory.links.delete(k);
  for (const t of memory.tables.values()) if (t.superseded_by === id) memory.tables.set(t.id, { ...t, superseded_by: null });
}

/** The team's tables whose source still exists (pruning the rest), each with its source. */
async function memoryTables(teamId: string, filter: (t: TableRow) => boolean = () => true): Promise<Array<{ t: TableRow; source: SourceRecord }>> {
  const out: Array<{ t: TableRow; source: SourceRecord }> = [];
  const sources = new Map<string, SourceRecord | null>();
  for (const t of [...memory.tables.values()]) {
    if (t.team_id !== teamId || !filter(t)) continue;
    if (!sources.has(t.source_id)) sources.set(t.source_id, await getSource(teamId, t.source_id));
    const source = sources.get(t.source_id);
    if (!source) pruneTable(t.id);
    else out.push({ t, source });
  }
  return out;
}

async function memoryTable(teamId: string, id: string): Promise<{ t: TableRow; source: SourceRecord } | null> {
  const t = memory.tables.get(id);
  if (!t || t.team_id !== teamId) return null;
  return (await memoryTables(teamId, (x) => x.id === id))[0] ?? null;
}

/** The table's links whose document still exists (pruning the rest), oldest first. */
async function memoryLinks(teamId: string, filter: (l: LinkRow) => boolean): Promise<LinkRow[]> {
  const out: LinkRow[] = [];
  for (const [k, l] of [...memory.links]) {
    if (l.team_id !== teamId || !filter(l)) continue;
    if (await getDocument(teamId, l.document_id)) out.push(l);
    else memory.links.delete(k);
  }
  return out.sort((a, b) => a.added_at.localeCompare(b.added_at));
}

async function memorySummary(teamId: string, t: TableRow, source: SourceRecord): Promise<DataTableSummary> {
  const links = await memoryLinks(teamId, (l) => l.table_id === t.id);
  return toSummary(t, sourceOf(source), links.map((l) => l.document_id), memory.overrides.get(t.id)?.size ?? 0);
}

// --- Audit ---------------------------------------------------------------------

async function audit(agent: string, op: string, t: Pick<TableRow, "id" | "source_id">, teamId: string, args: Record<string, unknown> = {}, result: Record<string, unknown> = {}) {
  try {
    await defaultAuditSink().write({
      agent,
      action: `data_table.${op}`,
      args: { team_id: teamId, table_id: t.id, source_id: t.source_id, ...args },
      result: { status: "ok", ...result },
      allowed: true,
      groupId: t.id,
    });
  } catch (error) {
    console.error(`[data] audit of data_table.${op} for ${t.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Reads ---------------------------------------------------------------------

const SUMMARY_COLUMNS = `t.id, t.team_id, t.source_id, t.idx, t.match_key, t.name, t.columns, t.row_count, t.status, t.superseded_by,
  t.extraction_method, t.sheet, t.page, t.page_end, t.confidence, t.notes, t.truncated, t.created_by, t.created_at, t.updated_at,
  s.title AS source_title, s.filename AS source_filename, s.kind AS source_kind, s.mime AS source_mime,
  ARRAY(SELECT dd.document_id::text FROM document_data dd WHERE dd.table_id = t.id ORDER BY dd.added_at) AS document_ids,
  (SELECT COUNT(*)::int FROM data_cell_override o WHERE o.table_id = t.id) AS override_count`;
const SUMMARY_FROM = `data_table t JOIN source s ON s.id = t.source_id AND s.team_id = t.team_id`;

const newestFirst = (a: TableRow, b: TableRow) => b.created_at.localeCompare(a.created_at) || a.idx - b.idx;

export async function listTables(teamId: string, q: TableQuery = {}): Promise<DataTableSummary[]> {
  const status = q.status?.length ? q.status : (["active"] as TableStatus[]);
  const needle = q.query?.trim() ?? "";
  const limit = Math.min(Math.max(q.limit ?? MAX_LIST_TABLES, 1), MAX_LIST_TABLES);
  for (const id of [q.sourceId, q.documentId, q.forDocument]) if (id !== undefined && !isUuid(id)) return [];
  if (!hasDb()) {
    const lower = needle.toLowerCase();
    const hit = (v: string | null) => !!v && v.toLowerCase().includes(lower);
    let forSources: Set<string> | null = null;
    if (q.forDocument) {
      // The sources linked to the document (the sources store owns those links).
      forSources = new Set(((await listDocumentSources(teamId, q.forDocument)) ?? []).map((s) => s.id));
    }
    const linked = q.documentId ? new Set((await memoryLinks(teamId, (l) => l.document_id === q.documentId)).map((l) => l.table_id)) : null;
    const found = (await memoryTables(teamId, (t) => status.includes(t.status) && (!q.sourceId || t.source_id === q.sourceId)))
      .filter(({ t }) => !linked || linked.has(t.id))
      .filter(({ t }) => !forSources || forSources.has(t.source_id))
      .filter(({ t, source }) => !lower || hit(t.name) || t.columns.some((c) => hit(c.label)) || hit(source.title) || hit(source.filename))
      .sort((a, b) => newestFirst(a.t, b.t))
      .slice(0, limit);
    return Promise.all(found.map(({ t, source }) => memorySummary(teamId, t, source)));
  }
  await schema();
  const params: unknown[] = [teamId];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ["t.team_id = $1", `t.status = ANY(${param(status)}::text[])`];
  if (q.sourceId) where.push(`t.source_id = ${param(q.sourceId)}::uuid`);
  if (q.documentId) where.push(`EXISTS (SELECT 1 FROM document_data dd WHERE dd.table_id = t.id AND dd.document_id = ${param(q.documentId)}::uuid)`);
  if (q.forDocument) where.push(`EXISTS (SELECT 1 FROM document_source ds WHERE ds.source_id = t.source_id AND ds.document_id = ${param(q.forDocument)}::uuid)`);
  if (needle) {
    const like = param(likePattern(needle));
    where.push(
      `(t.name ILIKE ${like} OR s.title ILIKE ${like} OR s.filename ILIKE ${like}` +
        ` OR EXISTS (SELECT 1 FROM jsonb_array_elements(t.columns) c WHERE c->>'label' ILIKE ${like}))`,
    );
  }
  const { rows } = await sql.query(
    `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC, t.idx LIMIT ${param(limit)}`,
    params,
  );
  return rows.map(rowToSummary);
}

/** Internal: the table row and its summary, or null when it isn't the team's. */
async function loadTable(teamId: string, id: string): Promise<{ row: TableRow; summary: DataTableSummary } | null> {
  if (!isUuid(id)) return null;
  if (!hasDb()) {
    const found = await memoryTable(teamId, id);
    return found ? { row: found.t, summary: await memorySummary(teamId, found.t, found.source) } : null;
  }
  await schema();
  const { rows } = await sql.query(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE t.id = $1 AND t.team_id = $2`, [id, teamId]);
  return rows[0] ? { row: rowToTable(rows[0]), summary: rowToSummary(rows[0]) } : null;
}

export async function getTable(teamId: string, id: string): Promise<DataTableSummary | null> {
  return (await loadTable(teamId, id))?.summary ?? null;
}

const pad = (cells: Cell[], width: number): Cell[] => Array.from({ length: width }, (_, i) => cells[i] ?? null);

/** Overrides applied to source rows, aligned with the columns. */
function applyOverrides(columns: DataColumn[], rows: Array<{ idx: number; cells: Cell[] }>, overrides: OverrideRow[]): DataRow[] {
  const byRow = new Map<number, OverrideRow[]>();
  for (const o of overrides) byRow.set(o.row_idx, [...(byRow.get(o.row_idx) ?? []), o]);
  const colIndex = new Map(columns.map((c, i) => [c.key, i]));
  return rows.map((r) => {
    const cells = pad(r.cells, columns.length);
    const row: DataRow = { idx: r.idx, cells };
    for (const o of byRow.get(r.idx) ?? []) {
      const i = colIndex.get(o.col_key);
      if (i === undefined) continue;
      cells[i] = o.value;
      (row.overrides ??= {})[o.col_key] = { original: o.original, by: o.created_by, at: o.created_at } satisfies CellOverride;
    }
    return row;
  });
}

function rowToOverride(r: Record<string, unknown>): OverrideRow {
  return { row_idx: Number(r.row_idx), col_key: String(r.col_key), value: str(r.value), original: str(r.original), created_by: String(r.created_by ?? ""), created_at: iso(r.created_at) };
}

async function readRows(t: TableRow, offset: number, limit: number): Promise<DataRow[]> {
  const from = Math.max(0, Math.floor(offset));
  const count = Math.min(Math.max(Math.floor(limit), 1), MAX_TABLE_ROWS);
  if (!hasDb()) {
    const source = (memory.rows.get(t.id) ?? []).slice(from, from + count).map((cells, i) => ({ idx: from + i, cells }));
    const overrides = [...(memory.overrides.get(t.id)?.values() ?? [])].filter((o) => o.row_idx >= from && o.row_idx < from + count);
    return applyOverrides(t.columns, source, overrides);
  }
  const [{ rows }, { rows: over }] = await Promise.all([
    sql.query(`SELECT idx, cells FROM data_row WHERE table_id = $1 AND idx >= $2 ORDER BY idx LIMIT $3`, [t.id, from, count]),
    sql.query(`SELECT row_idx, col_key, value, original, created_by, created_at FROM data_cell_override WHERE table_id = $1 AND row_idx >= $2 AND row_idx < $3`, [
      t.id,
      from,
      from + count,
    ]),
  ]);
  return applyOverrides(
    t.columns,
    rows.map((r) => ({ idx: Number(r.idx), cells: parseCells(r.cells) })),
    over.map(rowToOverride),
  );
}

/** A page of rows with overrides applied; null when the table isn't the team's. */
export async function getTableRows(teamId: string, id: string, offset: number, limit: number): Promise<DataRow[] | null> {
  const found = await loadTable(teamId, id);
  return found ? readRows(found.row, offset, limit) : null;
}

/** The document's linked tables (any status), oldest link first; null when the document isn't the team's. */
export async function listDocumentTables(teamId: string, documentId: string): Promise<LinkedDataTable[] | null> {
  if (!(await getDocument(teamId, documentId))) return null;
  if (!hasDb()) {
    const links = await memoryLinks(teamId, (l) => l.document_id === documentId);
    const out: LinkedDataTable[] = [];
    for (const l of links) {
      const found = await memoryTable(teamId, l.table_id);
      if (found) out.push({ ...(await memorySummary(teamId, found.t, found.source)), added_by: l.added_by, added_at: l.added_at });
    }
    return out;
  }
  await schema();
  const { rows } = await sql.query(
    `SELECT ${SUMMARY_COLUMNS}, l.added_by AS link_added_by, l.added_at AS link_added_at
       FROM document_data l JOIN ${SUMMARY_FROM} ON t.id = l.table_id
      WHERE l.document_id = $1 AND l.team_id = $2 AND t.team_id = $2
      ORDER BY l.added_at`,
    [documentId, teamId],
  );
  return rows.map((r) => ({ ...rowToSummary(r), added_by: String(r.link_added_by ?? ""), added_at: iso(r.link_added_at) }));
}

// --- A fresh read of a source ---------------------------------------------------

/**
 * Record a fresh extraction of a source's tables: the source's earlier
 * extracted tables (active or hidden) become superseded, the new ones are
 * inserted, and a new table with the same match_key as an old one takes over
 * its document links, hidden status and superseded_by pointer. Earlier tables
 * on pages the read couldn't reach (`keepPages`) are left alone. Null when the
 * source isn't the team's.
 *
 * The new tables go in before the old ones are superseded, so a failure part
 * way leaves both sets readable rather than none.
 */
export async function replaceSourceTables(teamId: string, sourceId: string, agent: string, tables: ExtractedTable[], opts: ReplaceOptions = {}): Promise<ReplaceResult | null> {
  // One replace per source at a time in this process: each reads the current
  // set inside the turn, so a second can't miss the first's tables. (Across
  // instances, ingest's claim on the source keeps two reads from overlapping.)
  const key = `${teamId}:${sourceId}`;
  const before = replacing.get(key) ?? Promise.resolve();
  const run = before.then(() => replaceNow(teamId, sourceId, agent, tables, opts));
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  replacing.set(key, settled);
  void settled.then(() => {
    if (replacing.get(key) === settled) replacing.delete(key);
  });
  return run;
}

const replacing = new Map<string, Promise<void>>();

async function replaceNow(teamId: string, sourceId: string, agent: string, tables: ExtractedTable[], opts: ReplaceOptions): Promise<ReplaceResult | null> {
  if (!(await getSource(teamId, sourceId))) return null;
  const fresh = tables.slice(0, MAX_TABLES_PER_SOURCE);
  const current = await currentTables(teamId, sourceId);
  const freshKeys = new Set(fresh.map((t) => t.match_key));
  const unread = (page: number | null) => page !== null && (opts.keepPages ?? []).some((r) => page >= r.first && (r.last === null || page <= r.last));
  // An earlier table on an unread page stays, unless a fresh table takes its place.
  const old = current.filter((o) => freshKeys.has(o.match_key) || !unread(o.page));
  // The first old table per match_key is the one a new table takes over from.
  const oldByKey = new Map<string, { id: string; status: TableStatus }>();
  for (const o of old) if (!oldByKey.has(o.match_key)) oldByKey.set(o.match_key, o);

  const at = nowIso();
  const planned = fresh.map((t, idx) => {
    const match = oldByKey.get(t.match_key);
    // A key matches at most one new table (the first).
    if (match) oldByKey.delete(t.match_key);
    const row: TableRow = {
      id: randomUUID(),
      team_id: teamId,
      source_id: sourceId,
      idx,
      match_key: t.match_key,
      name: t.name.slice(0, MAX_LABEL_CHARS),
      columns: t.columns.map((c) => ({ ...c })),
      row_count: t.rows.length,
      status: match?.status === "hidden" ? "hidden" : "active",
      superseded_by: null,
      extraction_method: t.extraction_method,
      sheet: t.sheet,
      page: t.page,
      page_end: t.page_end,
      confidence: t.confidence,
      notes: t.notes,
      truncated: t.truncated,
      created_by: agent,
      created_at: at,
      updated_at: at,
    };
    return { row, rows: t.rows.map((r) => pad(r, t.columns.length)), replaces: match?.id ?? null };
  });

  // Inserts aren't one transaction (the pooled client has none), so a failed
  // batch removes what this read already wrote rather than leave a half-filled
  // active table beside the old ones.
  const written: string[] = [];
  try {
    for (const p of planned) {
      written.push(p.row.id);
      await insertTable(p.row, p.rows);
    }
  } catch (error) {
    await removeTables(teamId, written).catch((cleanup) => console.error("[data] could not remove a partly written table:", cleanup));
    throw error;
  }
  await supersede(teamId, old.map((o) => o.id));
  for (const p of planned) {
    if (!p.replaces) continue;
    const moved = await takeOver(teamId, p.replaces, p.row.id);
    for (const documentId of moved) await audit(agent, "relink", { id: p.row.id, source_id: sourceId }, teamId, { document_id: documentId, from_table_id: p.replaces });
    // The tables are stored either way; a suggestion left on the old id only loses its "Covered by" name.
    await retargetSuggestionTable(teamId, p.replaces, p.row.id).catch((error) => console.error("[data] could not move suggestions to the new table:", error));
  }
  return { inserted: planned.length, superseded: old.length };
}

async function currentTables(teamId: string, sourceId: string): Promise<Array<{ id: string; match_key: string; status: TableStatus; page: number | null }>> {
  if (!hasDb()) {
    return [...memory.tables.values()]
      .filter((t) => t.team_id === teamId && t.source_id === sourceId && (t.status === "active" || t.status === "hidden"))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.idx - b.idx)
      .map((t) => ({ id: t.id, match_key: t.match_key, status: t.status, page: t.page }));
  }
  await schema();
  const { rows } = await sql`
    SELECT id, match_key, status, page FROM data_table
     WHERE team_id = ${teamId} AND source_id = ${sourceId} AND status IN ('active', 'hidden')
     ORDER BY created_at, idx`;
  return rows.map((r) => ({
    id: String(r.id),
    match_key: String(r.match_key),
    status: oneOf(TABLE_STATUSES, r.status, "active"),
    page: r.page === null || r.page === undefined ? null : Number(r.page),
  }));
}

async function insertTable(t: TableRow, rows: Cell[][]): Promise<void> {
  if (!hasDb()) {
    memory.tables.set(t.id, t);
    memory.rows.set(t.id, rows);
    return;
  }
  await sql.query(
    `INSERT INTO data_table (id, team_id, source_id, idx, match_key, name, columns, row_count, status, extraction_method, sheet, page, page_end, confidence, notes, truncated, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      t.id,
      t.team_id,
      t.source_id,
      t.idx,
      t.match_key,
      t.name,
      JSON.stringify(t.columns),
      t.row_count,
      t.status,
      t.extraction_method satisfies ExtractionMethod,
      t.sheet,
      t.page,
      t.page_end,
      t.confidence,
      t.notes,
      t.truncated,
      t.created_by,
    ],
  );
  for (let start = 0; start < rows.length; start += ROW_INSERT_BATCH) {
    const batch = rows.slice(start, start + ROW_INSERT_BATCH);
    await sql.query(`INSERT INTO data_row (table_id, idx, cells) SELECT $1::uuid, u.i, u.c::jsonb FROM unnest($2::int[], $3::text[]) AS u(i, c)`, [
      t.id,
      batch.map((_, i) => start + i),
      batch.map((r) => JSON.stringify(r)),
    ]);
  }
}

/** Delete tables this read wrote (their rows go by the foreign-key cascade). */
async function removeTables(teamId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (!hasDb()) {
    for (const id of ids) pruneTable(id);
    return;
  }
  await sql.query(`DELETE FROM data_table WHERE team_id = $1 AND id = ANY($2::uuid[])`, [teamId, ids]);
}

async function supersede(teamId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (!hasDb()) {
    const at = nowIso();
    for (const id of ids) {
      const t = memory.tables.get(id);
      if (t && t.team_id === teamId) memory.tables.set(id, { ...t, status: "superseded", updated_at: at });
    }
    return;
  }
  await sql.query(`UPDATE data_table SET status = 'superseded', updated_at = now() WHERE team_id = $1 AND id = ANY($2::uuid[]) AND status IN ('active', 'hidden')`, [teamId, ids]);
}

/** The new table replaces the old one: superseded_by points at it and the old table's document links move to it. Returns the moved documents. */
async function takeOver(teamId: string, oldId: string, newId: string): Promise<string[]> {
  if (!hasDb()) {
    const old = memory.tables.get(oldId);
    if (old) memory.tables.set(oldId, { ...old, superseded_by: newId });
    const moved: string[] = [];
    for (const [k, l] of [...memory.links]) {
      if (l.table_id !== oldId || l.team_id !== teamId) continue;
      memory.links.delete(k);
      const next = linkKey(l.document_id, newId);
      if (!memory.links.has(next)) memory.links.set(next, { ...l, table_id: newId });
      moved.push(l.document_id);
    }
    return moved;
  }
  await sql`UPDATE data_table SET superseded_by = ${newId} WHERE id = ${oldId} AND team_id = ${teamId}`;
  await sql`
    INSERT INTO document_data (document_id, table_id, team_id, added_by, added_at)
    SELECT document_id, ${newId}, team_id, added_by, added_at FROM document_data WHERE table_id = ${oldId} AND team_id = ${teamId}
    ON CONFLICT (document_id, table_id) DO NOTHING`;
  const { rows } = await sql`DELETE FROM document_data WHERE table_id = ${oldId} AND team_id = ${teamId} RETURNING document_id`;
  return rows.map((r) => String(r.document_id));
}

// --- A person's changes ------------------------------------------------------------

type TableFields = Partial<Pick<TableRow, "name" | "columns" | "status" | "superseded_by">>;

async function writeTable(teamId: string, id: string, fields: TableFields): Promise<void> {
  if (!hasDb()) {
    const t = memory.tables.get(id);
    if (t && t.team_id === teamId) memory.tables.set(id, { ...t, ...fields, updated_at: nowIso() });
    return;
  }
  // Column names come from the fixed TableFields keys, never from input.
  const keys = Object.keys(fields) as Array<keyof TableFields>;
  const sets = keys.map((k, i) => (k === "columns" ? `columns = $${i + 3}::jsonb` : `${k} = $${i + 3}`)).join(", ");
  await sql.query(`UPDATE data_table SET ${sets ? `${sets}, ` : ""}updated_at = now() WHERE id = $1 AND team_id = $2`, [
    id,
    teamId,
    ...keys.map((k) => (k === "columns" ? JSON.stringify(fields.columns) : (fields[k] ?? null))),
  ]);
}

/** True when following `from`'s superseded_by chain reaches `target` (or loops). */
async function chainReaches(teamId: string, from: TableRow, target: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let cur: string | null = from.superseded_by; cur; ) {
    if (cur === target || seen.has(cur)) return true;
    seen.add(cur);
    cur = (await loadTable(teamId, cur))?.row.superseded_by ?? null;
  }
  return false;
}

async function getOverride(tableId: string, row: number, key: string): Promise<OverrideRow | null> {
  if (!hasDb()) return memory.overrides.get(tableId)?.get(overrideKey(row, key)) ?? null;
  const { rows } = await sql`
    SELECT row_idx, col_key, value, original, created_by, created_at FROM data_cell_override
     WHERE table_id = ${tableId} AND row_idx = ${row} AND col_key = ${key}`;
  return rows[0] ? rowToOverride(rows[0]) : null;
}

async function sourceCell(t: TableRow, row: number, key: string): Promise<Cell> {
  const i = t.columns.findIndex((c) => c.key === key);
  if (!hasDb()) return memory.rows.get(t.id)?.[row]?.[i] ?? null;
  const { rows } = await sql`SELECT cells FROM data_row WHERE table_id = ${t.id} AND idx = ${row}`;
  return rows[0] ? (parseCells(rows[0].cells)[i] ?? null) : null;
}

async function putOverride(t: TableRow, o: OverrideRow): Promise<void> {
  if (!hasDb()) {
    const map = memory.overrides.get(t.id) ?? new Map<string, OverrideRow>();
    map.set(overrideKey(o.row_idx, o.col_key), o);
    memory.overrides.set(t.id, map);
    return;
  }
  // `original` is kept from the first override: a later edit never replaces it.
  await sql`
    INSERT INTO data_cell_override (table_id, row_idx, col_key, value, original, created_by)
    VALUES (${t.id}, ${o.row_idx}, ${o.col_key}, ${o.value}, ${o.original}, ${o.created_by})
    ON CONFLICT (table_id, row_idx, col_key) DO UPDATE SET value = EXCLUDED.value, created_by = EXCLUDED.created_by, created_at = now()`;
}

async function dropOverride(t: TableRow, row: number, key: string): Promise<void> {
  if (!hasDb()) {
    memory.overrides.get(t.id)?.delete(overrideKey(row, key));
    return;
  }
  await sql`DELETE FROM data_cell_override WHERE table_id = ${t.id} AND row_idx = ${row} AND col_key = ${key}`;
}

/** Apply one patch; every change is audited. */
export async function patchTable(teamId: string, agent: string, id: string, patch: DataTablePatch): Promise<PatchResult> {
  const found = await loadTable(teamId, id);
  if (!found) return { ok: false, reason: "not_found" };
  const t = found.row;
  const done = async (row?: DataRow): Promise<PatchResult> => {
    const table = await getTable(teamId, id);
    return table ? { ok: true, table, ...(row ? { row } : {}) } : { ok: false, reason: "not_found" };
  };

  switch (patch.op) {
    case "rename": {
      await writeTable(teamId, id, { name: patch.name });
      await audit(agent, "rename", t, teamId, { name: patch.name, old: t.name });
      return done();
    }
    case "column": {
      const col = t.columns.find((c) => c.key === patch.key);
      if (!col) return { ok: false, reason: "column_not_found" };
      const next: DataColumn = {
        ...col,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.type !== undefined ? { type: patch.type ?? col.inferred } : {}),
      };
      await writeTable(teamId, id, { columns: t.columns.map((c) => (c.key === col.key ? next : c)) });
      await audit(agent, "column", t, teamId, { key: col.key, label: next.label, type: next.type, old_label: col.label, old_type: col.type });
      return done();
    }
    case "hide":
    case "unhide": {
      const [from, to]: [TableStatus, TableStatus] = patch.op === "hide" ? ["active", "hidden"] : ["hidden", "active"];
      if (t.status !== from) return { ok: false, reason: "invalid_state" };
      await writeTable(teamId, id, { status: to });
      await audit(agent, patch.op, t, teamId);
      return done();
    }
    case "supersede": {
      if (t.status === "superseded") return { ok: false, reason: "invalid_state" };
      if (patch.by === id) return { ok: false, reason: "invalid_supersede" };
      const by = await loadTable(teamId, patch.by);
      if (!by || by.row.status !== "active" || (await chainReaches(teamId, by.row, id))) return { ok: false, reason: "invalid_supersede" };
      await writeTable(teamId, id, { status: "superseded", superseded_by: patch.by });
      await audit(agent, "supersede", t, teamId, { by: patch.by });
      return done();
    }
    case "restore": {
      if (t.status !== "superseded") return { ok: false, reason: "not_superseded" };
      await writeTable(teamId, id, { status: "active", superseded_by: null });
      await audit(agent, "restore", t, teamId, { old_superseded_by: t.superseded_by });
      return done();
    }
    case "override":
    case "revert": {
      if (patch.row >= t.row_count) return { ok: false, reason: "row_not_found" };
      if (!t.columns.some((c) => c.key === patch.key)) return { ok: false, reason: "column_not_found" };
      const existing = await getOverride(id, patch.row, patch.key);
      const original = existing ? existing.original : await sourceCell(t, patch.row, patch.key);
      const value = patch.op === "override" ? patch.value : original;
      if (patch.op === "revert" && !existing) return { ok: false, reason: "no_override" };
      const old = existing ? existing.value : original;
      if (value === original) {
        // Setting the source value is a revert; with no override there is nothing to change.
        if (existing) {
          await dropOverride(t, patch.row, patch.key);
          await writeTable(teamId, id, {});
          await audit(agent, "revert", t, teamId, { row: patch.row, key: patch.key, old, new: original });
        }
      } else if (value !== old) {
        await putOverride(t, { row_idx: patch.row, col_key: patch.key, value, original, created_by: agent, created_at: nowIso() });
        await writeTable(teamId, id, {});
        await audit(agent, "override", t, teamId, { row: patch.row, key: patch.key, old, new: value });
      }
      const [row] = await readRows(t, patch.row, 1);
      return done(row);
    }
  }
}

// --- Links ---------------------------------------------------------------------

/** Link a table of the team to a document of the team (idempotent; the first link's time and author stay). */
export async function linkTable(teamId: string, agent: string, documentId: string, tableId: string): Promise<"ok" | "document_not_found" | "table_not_found"> {
  if (!(await getDocument(teamId, documentId))) return "document_not_found";
  const found = await loadTable(teamId, tableId);
  if (!found) return "table_not_found";
  let added: boolean;
  if (!hasDb()) {
    const k = linkKey(documentId, tableId);
    added = !memory.links.has(k);
    if (added) memory.links.set(k, { document_id: documentId, table_id: tableId, team_id: teamId, added_by: agent, added_at: nowIso() });
  } else {
    const { rowCount } = await sql`
      INSERT INTO document_data (document_id, table_id, team_id, added_by)
      VALUES (${documentId}, ${tableId}, ${teamId}, ${agent})
      ON CONFLICT (document_id, table_id) DO NOTHING`;
    added = (rowCount ?? 0) > 0;
  }
  if (added) await audit(agent, "link", found.row, teamId, { document_id: documentId });
  return "ok";
}

/**
 * Remove a table from a document. False when either isn't the team's or they
 * weren't linked. `agent` (who did it, for the audit entry) is optional so
 * callers written against the first signature keep working.
 */
export async function unlinkTable(teamId: string, documentId: string, tableId: string, agent = "system"): Promise<boolean> {
  if (!(await getDocument(teamId, documentId))) return false;
  const found = await loadTable(teamId, tableId);
  if (!found) return false;
  let removed: boolean;
  if (!hasDb()) {
    removed = memory.links.delete(linkKey(documentId, tableId));
  } else {
    const { rowCount } = await sql`DELETE FROM document_data WHERE document_id = ${documentId} AND table_id = ${tableId} AND team_id = ${teamId}`;
    removed = (rowCount ?? 0) > 0;
  }
  if (removed) await audit(agent, "unlink", found.row, teamId, { document_id: documentId });
  return removed;
}
