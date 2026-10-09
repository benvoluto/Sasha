// The pure parts of "tell me" (redesign2-spec.md §6.2): which headings to
// draft, one section's draft request, the drafting pool (a few at a time; a
// rate limit stops new ones and keeps what finished) and the document swap that
// leaves the whole run as a single undo step. use-tell-me.ts wires them to the
// editor and the screen.

import { closeHistory } from "@tiptap/pm/history";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { SectionSummary } from "@/catalog/schema";
import type { CitationReport } from "@/lib/citations/contract";
import type { SectionGenerateRequest, SectionGenerateResponse } from "@/lib/sections/contract";
import { draftableSections, tellMeInstruction } from "@/lib/tell-me/contract";
import { generationError } from "./use-section-generation";

export type TellMeTarget = { sectionId: string; heading: string; level: number; specKey: string };

/** The top-level headings laid out from the type whose section is drafted (not fixed/static), in document order. */
export function tellMeTargets(doc: PMNode, sections: Array<Pick<SectionSummary, "key" | "renderer">>): TellMeTarget[] {
  const draftable = new Set(draftableSections(sections).map((s) => s.key));
  const out: TellMeTarget[] = [];
  doc.forEach((node) => {
    if (node.type.name !== "heading") return;
    const sectionId = node.attrs.sectionId as string | null;
    const specKey = node.attrs.specKey as string | null;
    if (!sectionId || !specKey || !draftable.has(specKey)) return;
    out.push({ sectionId, heading: node.textContent, level: Number(node.attrs.level ?? 2), specKey });
  });
  return out;
}

export type DraftOutcome =
  | { kind: "ok"; markdown: string; lineBreaks: boolean; citations: CitationReport | null }
  /** 429: the person's draft allowance is used up; no new sections start. */
  | { kind: "limited"; error: string }
  | { kind: "failed"; error: string };

/** The section generate route's body for one tell-me section. */
export function draftRequest(target: TellMeTarget, prompt: string): SectionGenerateRequest {
  return { mode: "draft", heading: target.heading, level: target.level, specKey: target.specKey, body: "", instruction: tellMeInstruction(prompt) };
}

/** Draft one section through POST /api/documents/{id}/sections/{sectionId}/generate. Never throws. */
export async function draftSection(fetchFn: typeof fetch, documentId: string, target: TellMeTarget, prompt: string): Promise<DraftOutcome> {
  const label = `“${target.heading.trim() || "Untitled section"}”`;
  let res: Response;
  try {
    res = await fetchFn(`/api/documents/${documentId}/sections/${encodeURIComponent(target.sectionId)}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftRequest(target, prompt)),
    });
  } catch {
    return { kind: "failed", error: `${label}: Couldn't reach the server.` };
  }
  const body = (await res.json().catch(() => ({}))) as Partial<SectionGenerateResponse> & { error?: unknown };
  if (res.status === 429) return { kind: "limited", error: generationError(429, body) };
  if (!res.ok) return { kind: "failed", error: `${label}: ${generationError(res.status, body)}` };
  return { kind: "ok", markdown: String(body.markdown ?? ""), lineBreaks: body.lineBreaks === true, citations: body.citations ?? null };
}

export type DraftPoolOptions<T> = {
  items: T[];
  concurrency: number;
  draft: (item: T) => Promise<DraftOutcome>;
  /** Checked before each new item starts (Stop pressed, editor gone). */
  stopped: () => boolean;
  onStart?: (item: T) => void;
  onResult: (item: T, outcome: DraftOutcome) => void;
};

/**
 * Draft the items `concurrency` at a time, in order. A "limited" outcome stops
 * new items from starting; the ones already running finish and are reported.
 * Resolves once every started item has been reported.
 */
export async function runDraftPool<T>({ items, concurrency, draft, stopped, onStart, onResult }: DraftPoolOptions<T>): Promise<void> {
  let next = 0;
  let limited = false;
  const worker = async () => {
    while (!limited && !stopped() && next < items.length) {
      const item = items[next++];
      onStart?.(item);
      const outcome = await draft(item);
      if (outcome.kind === "limited") limited = true;
      onResult(item, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/**
 * A transaction replacing the whole document with `json`. Out of the history,
 * it is a layout step (the outline, a draft, the swap back); in it, it is its
 * own undo step (closeHistory, so it never merges with an earlier edit).
 */
export function replaceDocTr(state: EditorState, json: unknown, addToHistory: boolean): Transaction {
  const doc = PMNodeClass.fromJSON(state.schema, json);
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
  return addToHistory ? closeHistory(tr) : tr.setMeta("addToHistory", false);
}

/** The result card's line under the count: what Undo does, when there is something to undo. */
export function tellMeUndoNote(done: number): string | null {
  return done > 0 ? "Undo removes the text; the type and notes stay." : null;
}

/** How a run ended: failed only when nothing was drafted and something went wrong. */
export function finalPhase(done: number, errors: string[]): "done" | "failed" {
  return done === 0 && errors.length > 0 ? "failed" : "done";
}
