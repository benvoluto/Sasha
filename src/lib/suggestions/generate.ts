// Generating a document's suggestions (phase4-spec.md §4.3).
//
// The type's sourcesNeeded/dataNeeded give the "type" items. When Claude is
// configured and there is something to judge (type items and linked sources
// with summaries, or notes of some length), ONE fast-tier call (`suggest.items`)
// says which items a linked source already covers and proposes up to 8 more
// items the notes imply ("notes" origin). The document's linked active data
// tables go in the prompt too (Phase 5), and a data item a table clearly
// provides is covered by that table. Everything the model returns is
// whitelisted: source ids against the document's linked sources (and, for data
// items only, its linked active tables), spec_refs against the type's section
// keys. Without Claude the type items are written
// uncovered and there are no notes items.
//
// A generation runs at most once a minute per document (suggestion_run, so the
// gate holds across server processes), concurrent requests for a document
// share one run, and unchanged inputs (type, notes, linked sources and tables) skip it.
// A failed model call records its error, adds any type items still missing
// (uncovered) and otherwise leaves the list as it was; the list stays stale
// so the next open of the tab retries.
//
// A run that will call the model counts one call of the caller's "light"
// allowance (src/lib/limits); a refusal throws ModelCallLimitedError before
// anything is written, and the route answers 429.

import { getType } from "@/catalog";
import { sortedSections, type DocumentTypeDefinition } from "@/catalog/schema";
import { tableLocation, type LinkedDataTable } from "@/lib/data/contract";
import { listDocumentTables } from "@/lib/data/store";
import { getDocument, type DocumentRecord } from "@/lib/documents/store";
import type { LimitSubject } from "@/lib/limits/contract";
import { limitSubject, reserveOrThrow } from "@/lib/limits/reserve";
import { claudeConfigured, claudeJson } from "@/lib/llm/claude";
import { processMemory } from "@/lib/process-memory";
import { listDocumentSources, type LinkedSource } from "@/lib/sources/store";
import { MAX_SUGGESTION_LABEL, MAX_SUGGESTION_REASON, suggestionDedupeKey, type SuggestionGenerateResponse, type SuggestionListResponse, type SuggestionRecord } from "./contract";
import { inputsHash, mergeProposals, MAX_NOTES_PROPOSALS, subtractDismissed, typeNeeds, type GeneratedItem, type NeededItem } from "./diff";
import { MAX_PROMPT_TABLES, SUGGEST_SYSTEM, SuggestModelOutput, suggestUserPrompt, type PromptSource, type PromptTable } from "./prompt";
import { applyGenerated, getRun, listSuggestions, setRun } from "./store";

/** At most one generation per document per minute. */
export const MIN_GENERATE_INTERVAL_MS = 60_000;
/** Notes shorter than this (in words) don't call the model on their own. */
export const NOTES_MIN_WORDS = 20;

/** The generate response, plus (when the gate held the run back) how long until it opens. */
export type GenerateResult = SuggestionGenerateResponse & { retry_after_ms?: number };

const inflight = processMemory("suggestions.inflight", () => new Map<string, Promise<GenerateResult | null>>());

/** Forgets runs in progress (tests). */
export function resetSuggestionGenerator() {
  inflight.clear();
}

const wordCount = (s: string) => (s.match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? []).length;

export function sourceLabel(s: Pick<LinkedSource, "title" | "filename" | "url" | "kind">): string {
  return s.title?.trim() || s.filename?.trim() || s.url?.trim() || (s.kind === "note" ? "Untitled note" : "Untitled source");
}

/** A linked table for the prompt: "label (type)" columns, and its source with where in it the table sits. */
export function promptTable(t: LinkedDataTable): PromptTable {
  const where = tableLocation(t);
  const source = t.source.title?.trim() || t.source.filename?.trim() || "an untitled source";
  return { id: t.id, name: t.name, columns: t.columns.map((c) => `${c.label} (${c.type})`), row_count: t.row_count, source: where ? `${source}, ${where}` : source };
}

type Inputs = { doc: DocumentRecord; def: DocumentTypeDefinition | null; sources: LinkedSource[]; tables: LinkedDataTable[]; hash: string };

async function loadInputs(teamId: string, documentId: string): Promise<Inputs | null> {
  const doc = await getDocument(teamId, documentId);
  if (!doc) return null;
  const [entry, linked, linkedTables] = await Promise.all([getType(teamId, doc.type_key), listDocumentSources(teamId, documentId), listDocumentTables(teamId, documentId)]);
  const def = entry?.definition ?? null;
  const sources = linked ?? [];
  // Hidden and superseded tables are on the Data tab but don't cover anything.
  const tables = (linkedTables ?? []).filter((t) => t.status === "active").slice(0, MAX_PROMPT_TABLES);
  const hash = inputsHash({
    typeKey: def?.key ?? null,
    typeVersion: def?.version ?? null,
    notes: doc.notes,
    sources: sources.map((s) => ({ id: s.id, title: sourceLabel(s), summary: s.summary })),
    tables: tables.map((t) => ({ id: t.id, name: t.name, status: t.status, columns: t.columns.map((c) => ({ label: c.label, type: c.type })) })),
  });
  return { doc, def, sources, tables, hash };
}

async function listResponse(teamId: string, documentId: string, hash: string): Promise<SuggestionListResponse | null> {
  const [suggestions, run] = await Promise.all([listSuggestions(teamId, documentId), getRun(teamId, documentId)]);
  if (!suggestions) return null;
  // A failed run recorded the inputs it tried, but they were never judged: stay stale so opening the tab retries (the gate still spaces it).
  return { suggestions, stale: !run || !!run.error || run.inputs_hash !== hash, generated_at: run?.generated_at ?? null, error: run?.error ?? null };
}

/** GET /api/documents/[id]/suggestions: the list and whether it is stale. Null when the document isn't the team's. */
export async function getSuggestionList(teamId: string, documentId: string): Promise<SuggestionListResponse | null> {
  const inputs = await loadInputs(teamId, documentId);
  return inputs ? listResponse(teamId, documentId, inputs.hash) : null;
}

/**
 * The model's reply, whitelisted: coverage entries for items that exist and
 * sources that are linked (a linked table's id only for a data item, which it
 * then covers as `covered_by_table`); proposals with trimmed labels/reasons
 * and spec_refs that name one of the type's sections.
 */
export function judgeReply(
  reply: SuggestModelOutput,
  items: NeededItem[],
  sources: Array<{ id: string; title: string }>,
  sectionKeys: Set<string>,
  tables: Array<{ id: string; name: string }> = [],
): { typeItems: GeneratedItem[]; proposals: GeneratedItem[] } {
  const titles = new Map(sources.map((s) => [s.id, s.title]));
  const tableNames = new Map(tables.map((t) => [t.id, t.name]));
  const verdict = new Map<number, { status: "covered" | "partial"; source: string; table: boolean }>();
  for (const c of reply.coverage) {
    const index = c.item - 1;
    if (!Number.isInteger(index) || index < 0 || index >= items.length || c.status === "missing") continue;
    const source = c.source_id?.trim() ?? "";
    // A table covers only data items; on any other item the verdict is dropped (the item stays missing).
    const table = !titles.has(source) && tableNames.has(source);
    if (!titles.has(source) && !(table && items[index].kind === "data")) continue;
    // Keep the strongest verdict when an item is listed twice.
    if (verdict.get(index)?.status === "covered") continue;
    verdict.set(index, { status: c.status, source, table });
  }
  const typeItems: GeneratedItem[] = items.map((item, i) => {
    const v = verdict.get(i);
    const { dedupe_key: _k, ...rest } = item;
    void _k;
    if (!v) return rest;
    if (v.status === "covered") return v.table ? { ...rest, covered_by_table: v.source } : { ...rest, covered_by: v.source };
    const by = v.table ? tableNames.get(v.source) : titles.get(v.source);
    return { ...rest, reason: `${item.reason} (partly covered by ${by})`.slice(0, MAX_SUGGESTION_REASON) };
  });
  const proposals: GeneratedItem[] = reply.proposals
    .map((p) => ({
      kind: p.kind,
      label: p.label.trim().replace(/\s+/g, " ").slice(0, MAX_SUGGESTION_LABEL),
      reason: p.reason.trim().slice(0, MAX_SUGGESTION_REASON),
      spec_ref: p.spec_ref && sectionKeys.has(p.spec_ref) ? p.spec_ref : null,
    }))
    .filter((p) => p.label.length > 0);
  return { typeItems, proposals: mergeProposals(items, proposals).slice(0, MAX_NOTES_PROPOSALS) };
}

export type GenerateOptions = {
  force?: boolean;
  agent?: string;
  /** Whose "light" allowance a model run counts against; defaults to the request's model context. */
  subject?: LimitSubject | null;
  now?: () => number;
};

/** `items`, with each one that already has an open row taking that row's reason, spec_ref and url, so writing them changes nothing it doesn't add. */
function keepExisting(items: GeneratedItem[], existing: SuggestionRecord[]): GeneratedItem[] {
  const byKey = new Map(existing.map((r) => [suggestionDedupeKey(r.kind, r.label), r]));
  return items.map((item) => {
    const row = byKey.get(suggestionDedupeKey(item.kind, item.label));
    return row ? { ...item, reason: row.reason, spec_ref: row.spec_ref, url: row.url } : item;
  });
}

async function run(teamId: string, inputs: Inputs, opts: GenerateOptions): Promise<GenerateResult | null> {
  const { doc, def, sources, tables, hash } = inputs;
  const agent = opts.agent ?? "system";
  const now = opts.now ?? Date.now;
  const existing = (await listSuggestions(teamId, doc.id)) ?? [];
  const needed = def ? subtractDismissed(typeNeeds(def), existing) : [];
  const summarized: PromptSource[] = sources.filter((s) => s.summary?.trim()).map((s) => ({ id: s.id, title: sourceLabel(s), summary: s.summary!.trim() }));
  const notesWords = wordCount(doc.notes);
  const configured = claudeConfigured();
  const useModel = configured && ((needed.length > 0 && (summarized.length > 0 || tables.length > 0)) || notesWords >= NOTES_MIN_WORDS);

  let typeItems: GeneratedItem[] = needed.map(({ dedupe_key: _k, ...rest }) => (void _k, rest));
  let notesItems: GeneratedItem[] = [];
  if (useModel) {
    await reserveOrThrow(limitSubject(opts.subject), "light", { now: now() });
    const sections = def ? sortedSections(def.sections).map((s) => ({ key: s.key, heading: s.heading })) : [];
    try {
      const { data } = await claudeJson({
        task: "suggest.items",
        system: SUGGEST_SYSTEM,
        user: suggestUserPrompt({
          items: needed,
          sources: summarized,
          tables: tables.map(promptTable),
          notes: doc.notes,
          type: def ? { title: def.title, sections } : null,
          earlier: existing.filter((r) => r.origin === "notes").map((r) => ({ kind: r.kind, label: r.label, state: r.state })),
        }),
        schema: SuggestModelOutput,
        agent,
        documentId: doc.id,
      });
      const judged = judgeReply(data, needed, summarized, new Set(sections.map((s) => s.key)), tables);
      typeItems = judged.typeItems;
      notesItems = judged.proposals;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The suggestions couldn't be generated.";
      console.error(`[suggestions] generation failed for document ${doc.id}: ${message}`);
      // The type items don't depend on the model: write any that are missing,
      // uncovered (as without Claude), so a failed first run still lists them.
      // Rows already there keep their wording and coverage from the last run.
      await applyGenerated(teamId, agent, doc.id, "type", keepExisting(typeItems, existing));
      await setRun(teamId, doc.id, { inputs_hash: hash, generated_at: new Date(now()).toISOString(), error: message });
      const list = await listResponse(teamId, doc.id, hash);
      return list && { ...list, ran: false };
    }
  }

  await applyGenerated(teamId, agent, doc.id, "type", typeItems);
  // Notes items that duplicate a type item were dropped above; a dismissed one stays dismissed (the store never touches it).
  const typeKeys = new Set(typeItems.map((i) => suggestionDedupeKey(i.kind, i.label)));
  await applyGenerated(teamId, agent, doc.id, "notes", notesItems.filter((i) => !typeKeys.has(suggestionDedupeKey(i.kind, i.label))));
  await setRun(teamId, doc.id, { inputs_hash: hash, generated_at: new Date(now()).toISOString(), error: null });
  const list = await listResponse(teamId, doc.id, hash);
  return list && { ...list, ran: configured };
}

/**
 * Regenerate the document's suggestions (see the header). Null when the
 * document isn't the team's. `ran` is false when nothing was asked of the
 * model: inputs unchanged, the per-document gate closed, Claude not configured
 * (type items are still written) or the model call failed (`error` says why).
 */
export async function generateSuggestions(teamId: string, documentId: string, opts: GenerateOptions = {}): Promise<GenerateResult | null> {
  const running = inflight.get(documentId);
  if (running) {
    const shared = await running;
    // A shared run's list is only handed to a caller whose team owns the document.
    if (shared && (await getDocument(teamId, documentId))) return shared;
  }
  // Registered before the first await, so a concurrent request finds it.
  const promise = gateAndRun(teamId, documentId, opts).finally(() => {
    if (inflight.get(documentId) === promise) inflight.delete(documentId);
  });
  inflight.set(documentId, promise);
  return promise;
}

async function gateAndRun(teamId: string, documentId: string, opts: GenerateOptions): Promise<GenerateResult | null> {
  const inputs = await loadInputs(teamId, documentId);
  if (!inputs) return null;
  const now = opts.now ?? Date.now;
  const last = await getRun(teamId, documentId);
  if (last && last.inputs_hash === inputs.hash && !last.error && !opts.force) {
    const list = await listResponse(teamId, documentId, inputs.hash);
    return list && { ...list, ran: false };
  }
  if (last) {
    const wait = MIN_GENERATE_INTERVAL_MS - (now() - Date.parse(last.generated_at));
    if (wait > 0) {
      const list = await listResponse(teamId, documentId, inputs.hash);
      return list && { ...list, ran: false, retry_after_ms: wait };
    }
  }
  return run(teamId, inputs, opts);
}
