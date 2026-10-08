// Test helpers for the step nodes: a document in the memory stores with
// sections, linked sources and passages, a hand-built NodeContext (the engine
// isn't needed to call a handler) and a resolved node from its spec. Used only
// by *.test.ts files.

import { fileTypeByKey } from "@/catalog/files";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import { typePolicy } from "@/catalog/workflows";
import type { TypeWorkflowPolicy } from "@/catalog/workflow-schema";
import { resetDataStore } from "@/lib/data/store";
import type { PMNode } from "@/lib/documents/sections";
import { createDocument, getDocument, resetMemoryStore, updateDocument, type DocumentRecord } from "@/lib/documents/store";
import { heading, para } from "@/lib/sections/test-fixtures";
import { createSource, linkSource, replacePassages, resetSourceStore, setSummary, type StoredPassage } from "@/lib/sources/store";
import { resetSuggestionStore } from "@/lib/suggestions/store";
import { passagePrefix } from "@/lib/sources/pages";
import type { WorkflowRunRecord } from "../contract";
import { NodeError, type NodeContext } from "../context";
import { NODE_SPEC_INDEX } from "../registry";
import type { ResolvedNode } from "../validate";
import { AFTER_PORT } from "../node-spec";

export const TEAM = "org:test";
export const AGENT = "tester@example.com";
export { heading, para };

export function resetStores() {
  resetMemoryStore();
  resetSourceStore();
  resetDataStore();
  resetSuggestionStore();
}

/** A resolved node of `type` with `config` merged over its defaults. */
export function nodeOf(type: string, config: Record<string, unknown> = {}, id = "n1"): ResolvedNode {
  const spec = NODE_SPEC_INDEX[type];
  if (!spec) throw new Error(`no spec for ${type}`);
  const node = { id, type, position: { x: 0, y: 0 }, config: { ...spec.defaults(), ...config }, loop: false, expanded: false };
  // Parsed strictly: a test config the spec rejects is a test bug, not a silent fall back to defaults.
  const cfg = spec.config.parse(node.config) as Record<string, unknown>;
  return { node, spec, config: cfg, inputs: [...spec.inputs(cfg), AFTER_PORT], outputs: spec.outputs(cfg) };
}

export function fakeRun(documentId: string): WorkflowRunRecord {
  const at = new Date().toISOString();
  return {
    id: "run1",
    team_id: TEAM,
    document_id: documentId,
    status: "running",
    pause_reason: null,
    workflow_id: "builtin:test",
    workflow_name: "Test workflow",
    workflow_version: 1,
    graph: { nodes: [], edges: [] } as unknown as WorkflowRunRecord["graph"],
    params: {},
    steps: {},
    outputs: {},
    checkpoints: {},
    outcome: null,
    changes: {},
    responses: {},
    raw: {},
    requested_by: AGENT,
    created_at: at,
    updated_at: at,
  };
}

/** A NodeContext over the memory stores. `type` defaults to the catalog file type of the document's type_key. */
export function ctxFor(documentId: string, opts: { type?: DocumentTypeDefinition | null; policy?: TypeWorkflowPolicy; deadline?: number } = {}): NodeContext {
  const memo = new Map<string, Promise<unknown>>();
  const document = async (): Promise<DocumentRecord> => {
    const d = await getDocument(TEAM, documentId);
    if (!d) throw new NodeError("the document was deleted");
    return d;
  };
  const type = async () => (opts.type !== undefined ? opts.type : (fileTypeByKey((await document()).type_key ?? "") ?? null));
  return {
    run: fakeRun(documentId),
    teamId: TEAM,
    documentId,
    agent: AGENT,
    deadline: opts.deadline ?? Date.now() + 250_000,
    memo<T>(key: string, load: () => Promise<T>) {
      if (!memo.has(key)) memo.set(key, load());
      return memo.get(key) as Promise<T>;
    },
    document,
    type,
    async policy() {
      if (opts.policy) return opts.policy;
      const t = await type();
      return typePolicy((await document()).type_key, t?.family);
    },
  };
}

/** A document with the given body, type, notes and linked note-sources (each with passages). */
export async function makeDocument(init: {
  title?: string;
  typeKey?: string | null;
  content?: PMNode[];
  notes?: string;
  sources?: Array<{ title: string; summary?: string; role?: string; passages?: string[] }>;
}) {
  const doc = await createDocument(TEAM, AGENT, { title: init.title ?? "Test document", type_key: init.typeKey ?? null, content_json: { type: "doc", content: init.content ?? [para("")] } });
  if (init.notes) await updateDocument(TEAM, doc.id, AGENT, { notes: init.notes });
  const sources: Array<{ id: string; passages: StoredPassage[] }> = [];
  for (const s of init.sources ?? []) {
    const rec = await createSource(TEAM, AGENT, { kind: "note", title: s.title, extraction_status: "ready", extracted_text: (s.passages ?? []).join("\n") });
    if (s.summary) await setSummary(TEAM, rec.id, s.summary);
    let offset = 0;
    const passages: StoredPassage[] = (s.passages ?? []).map((text, i) => {
      const p = { id: `${passagePrefix(rec.id)}.P${i + 1}`, idx: i, page: i + 1, start_offset: offset, end_offset: offset + text.length, text };
      offset += text.length + 1;
      return p;
    });
    if (passages.length) await replacePassages(TEAM, rec.id, passages);
    await linkSource(TEAM, AGENT, doc.id, rec.id, s.role ?? null);
    sources.push({ id: rec.id, passages });
  }
  return { doc: (await getDocument(TEAM, doc.id))!, sources };
}

/** A usage record for mocked model replies. */
export const USAGE = { model: "claude-sonnet-5-5", input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0 };
