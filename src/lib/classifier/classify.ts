// Running the document-type classifier for a saved document (PLAN §6.3,
// decision 10; phase4-spec.md §3.1). One fast-tier Claude call
// (`classify.type`) over the stored notes and text, normalized against the
// team's enabled types and stored through ./store (which never bumps
// updated_at).
//
// Cost guards, server side: at most one run per document every
// CLASSIFY_MIN_INTERVAL_MS from the stored last_classified_at (persistent and
// shared across processes; a failed run counts too), concurrent calls for a
// document share the run in progress, and an input identical to the last
// successful run's (hash in process memory) returns without asking the model.
// Only a run that will ask the model counts one call of the caller's "light"
// allowance (src/lib/limits); a refusal throws ModelCallLimitedError, records
// nothing on the document, and the route answers 429.

import { createHash } from "node:crypto";
import { z } from "zod";
import { getDocument, onMemoryStoreReset, type DocumentRecord } from "@/lib/documents/store";
import type { LimitSubject } from "@/lib/limits/contract";
import { limitSubject, reserveOrThrow } from "@/lib/limits/reserve";
import { claudeConfigured, claudeJson } from "@/lib/llm/claude";
import { processMemory } from "@/lib/process-memory";
import {
  CLASSIFY_MIN_INTERVAL_MS,
  CLASSIFY_MIN_TOTAL_WORDS,
  type ClassifyRateLimited,
  type ClassifyRequest,
  type ClassifyResponse,
  type ClassifyResult,
} from "./contract";
import { classifySystemForTeam, classifyUser } from "./prompt";
import { classifierView, writeClassifierFields } from "./store";
import { wordCount } from "./trigger";

/**
 * The schema sent to the model. Looser than ClassifyResult (no bounds), so a
 * slightly long `why` or a fourth candidate is trimmed by normalizeResult
 * instead of failing the whole call.
 */
export const ClassifyModelOutput = z.object({
  candidates: z.array(z.object({ key: z.string(), confidence: z.number(), why: z.string() })),
  freeform: z.boolean(),
});
export type ClassifyModelOutput = z.infer<typeof ClassifyModelOutput>;

const MAX_CANDIDATES = 3;
const WHY_CHARS = 300;
const HASH_LIMIT = 1000;

/** Keep only enabled keys, one per key (the most confident), confidence in [0, 1], best first, at most 3. */
export function normalizeResult(result: ClassifyModelOutput, enabledKeys: Set<string>): ClassifyResult {
  const best = new Map<string, ClassifyResult["candidates"][number]>();
  for (const c of result.candidates) {
    const key = c.key.trim();
    if (!enabledKeys.has(key)) continue;
    const confidence = Number.isFinite(c.confidence) ? Math.min(1, Math.max(0, c.confidence)) : 0;
    const why = c.why.trim().slice(0, WHY_CHARS);
    const prev = best.get(key);
    if (!prev || confidence > prev.confidence) best.set(key, { key, confidence, why });
  }
  const candidates = [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CANDIDATES);
  return { candidates, freeform: result.freeform || candidates.length === 0 };
}

export type ClassifyOutcome = { status: 200; body: ClassifyResponse } | { status: 429; body: ClassifyRateLimited };

export type ClassifyOptions = {
  trigger: ClassifyRequest["trigger"];
  /** Skip the 2-minute gate. Server-internal only (tests, live tests); never taken from a request body. */
  force?: boolean;
  agent?: string;
  /** Whose "light" allowance a model run counts against; defaults to the request's model context. */
  subject?: LimitSubject | null;
  now?: () => number;
};

/** Hash of the last successful run's exact input, by document. */
const lastInput = processMemory("classifier.lastInput", () => new Map<string, string>());
/** Runs in progress, by document: a concurrent call awaits the running one. */
const inflight = processMemory("classifier.inflight", () => new Map<string, Promise<ClassifyOutcome | null>>());

/** Clears the process memory (tests; also on resetMemoryStore). */
export function resetClassifierMemory() {
  lastInput.clear();
  inflight.clear();
}
onMemoryStoreReset(resetClassifierMemory);

function rememberInput(documentId: string, hash: string) {
  lastInput.delete(documentId);
  lastInput.set(documentId, hash);
  while (lastInput.size > HASH_LIMIT) lastInput.delete(lastInput.keys().next().value as string);
}

const inputHash = (system: string, user: string) => createHash("sha256").update(system).update("\u0000").update(user).digest("hex");

const skip = (reason: Extract<ClassifyResponse, { ran: false }>["reason"], doc: DocumentRecord): ClassifyOutcome => ({
  status: 200,
  body: { ran: false, reason, view: classifierView(doc) },
});

/** Classify a saved document; null when it isn't the team's. */
export async function classifyDocument(teamId: string, id: string, opts: ClassifyOptions): Promise<ClassifyOutcome | null> {
  const now = opts.now ?? Date.now;
  const doc = await getDocument(teamId, id);
  if (!doc) return null;
  if (!claudeConfigured()) return skip("not_configured", doc);
  const words = wordCount(doc.notes) + wordCount(doc.content_text);
  if (words < CLASSIFY_MIN_TOTAL_WORDS) return skip("too_short", doc);
  if (doc.type_source === "user" && opts.trigger !== "drift" && opts.trigger !== "manual") return skip("typed", doc);

  const running = inflight.get(id);
  if (running) return running;

  if (!opts.force && doc.last_classified_at) {
    const elapsed = now() - Date.parse(doc.last_classified_at);
    if (elapsed < CLASSIFY_MIN_INTERVAL_MS) {
      return {
        status: 429,
        body: { error: "The document was classified a moment ago.", retryAfterMs: Math.max(1, CLASSIFY_MIN_INTERVAL_MS - elapsed), view: classifierView(doc) },
      };
    }
  }

  const promise = run(teamId, doc, words, opts, now).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}

async function run(teamId: string, doc: DocumentRecord, words: number, opts: ClassifyOptions, now: () => number): Promise<ClassifyOutcome | null> {
  const { system, keys } = await classifySystemForTeam(teamId);
  const user = classifyUser({ title: doc.title, notes: doc.notes, text: doc.content_text });
  const hash = inputHash(system, user);
  if (lastInput.get(doc.id) === hash) return skip("unchanged", doc);
  await reserveOrThrow(limitSubject(opts.subject), "light", { now: now() });

  const at = new Date(now()).toISOString();
  try {
    const { data } = await claudeJson({ task: "classify.type", system, user, schema: ClassifyModelOutput, agent: opts.agent, documentId: doc.id });
    const result = normalizeResult(data, keys);
    // Dismissals may have changed while the model ran: build on the stored state.
    const latest = (await getDocument(teamId, doc.id)) ?? doc;
    const saved = await writeClassifierFields(teamId, doc.id, {
      type_confidence: result.candidates[0]?.confidence ?? null,
      last_classified_at: at,
      classifier_state: { ...latest.classifier_state, last: { ...result, at, trigger: opts.trigger }, words_at_last_run: words },
    });
    if (!saved) return null;
    rememberInput(doc.id, hash);
    return { status: 200, body: { ran: true, view: classifierView(saved) } };
  } catch (error) {
    console.error("[classifier] classify.type failed:", error instanceof Error ? error.message : error);
    // Record the attempt so a failing model isn't asked again inside the window.
    const saved = await writeClassifierFields(teamId, doc.id, { last_classified_at: at }).catch(() => null);
    return skip("failed", saved ?? doc);
  }
}
