// The change nodes. doc.write proposes document changes for the open editor
// to apply (as one undo step after a snapshot) and never writes the body
// itself; with target "section_notes" it appends findings to section notes,
// which leaves the body untouched. suggest.emit turns coverage gaps and web
// resources into suggestions (origin "coverage"), web ones marked unverified.
//
// With waitForResult (After Phase 9, the resume Tailor step) doc.write waits:
// it returns the change with WAIT_KEY set, the run awaits review while the
// author accepts or rejects each line and applies the accepted ones, and the
// changes route records the result and sets the step back to pending. Run
// again, it outputs the change as proposed, the result, the accepted lines
// and a table of every line with its result. With nothing to change it
// records "skipped" and does not wait.

import { getSectionMeta, putSectionNotes } from "@/lib/documents/section-store";
import { listSections } from "@/lib/documents/sections";
import { applyGenerated } from "@/lib/suggestions/store";
import type { GeneratedItem } from "@/lib/suggestions/diff";
import { CHANGED_LINE_KIND, type ChangedLine, type ChangeResult, type DocumentChangeOp, type Finding, type LineResultKind, type OutcomeTable, type ProposedChange, type ReplaceLine } from "../contract";
import { WAIT_KEY, type NodeHandler } from "../context";
import { asGaps } from "./web-find";
import { clip, flat, outcomeTable } from "./util";
import type { WebResource } from "./types";

// --- doc.write ------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOp = (v: unknown): v is DocumentChangeOp => isObj(v) && (v.op === "restructure" || v.op === "replace_section_body" || (v.op === "replace_lines" && Array.isArray(v.lines)));

/** Pure: the ops input as one list: ops, lists of ops (loops), and `{op}` records, in order. */
export function flattenOps(v: unknown): DocumentChangeOp[] {
  return flat(v).flatMap((x) => (isOp(x) ? [x] : isObj(x) && "op" in x ? flattenOps(x.op) : []));
}

/** Pure: a one-line summary of the ops. */
export function summarizeOps(ops: DocumentChangeOp[]): string {
  const parts: string[] = [];
  const restructure = ops.find((o): o is Extract<DocumentChangeOp, { op: "restructure" }> => o.op === "restructure");
  if (restructure) parts.push(`Restructures the document to ${restructure.plan.targetTitle}`);
  const bodies = ops.filter((o) => o.op === "replace_section_body");
  if (bodies.length) {
    const unsourced = bodies.reduce((n, o) => n + (o.op === "replace_section_body" ? o.trace.filter((t) => t.unsourced).length : 0), 0);
    parts.push(`${restructure ? "fills" : "Fills"} ${bodies.length} section${bodies.length === 1 ? "" : "s"}${unsourced ? ` (${unsourced} unsourced sentence${unsourced === 1 ? "" : "s"} marked)` : ""}`);
  }
  const lines = opLines(ops);
  if (lines.length) {
    const count = (a: ReplaceLine["action"]) => lines.filter((l) => l.action === a).length;
    const kinds = [
      count("rewrite") && `${count("rewrite")} rewrite${count("rewrite") === 1 ? "" : "s"}`,
      count("lead") && `${count("lead")} moved to the top`,
      count("trim") && `${count("trim")} trimmed`,
    ].filter(Boolean);
    parts.push(`${parts.length ? "proposes" : "Proposes"} ${lines.length} line change${lines.length === 1 ? "" : "s"} (${kinds.join(", ")})`);
  }
  return parts.length ? `${parts.join(", and ")}.` : "No changes.";
}

/** Pure: the change the editor will apply. */
export function proposeChange(nodeId: string, config: { title: string; snapshotReason: string }, ops: DocumentChangeOp[], basisUpdatedAt: string): ProposedChange {
  return { id: nodeId, title: config.title, summary: summarizeOps(ops), ops, basisUpdatedAt, snapshotReason: config.snapshotReason };
}

/** Pure: every proposed line across the replace_lines ops, in order. */
export function opLines(ops: DocumentChangeOp[]): ReplaceLine[] {
  return ops.flatMap((o) => (o.op === "replace_lines" ? o.lines : []));
}

/** A change's overall result, for a line the author's per-line results don't name. */
const LINE_RESULT_FOR: Record<ChangeResult["result"], LineResultKind> = { applied: "accepted", discarded: "rejected", skipped: "skipped" };

/** Pure: each proposed line with what the author did with it (its own result, else the change's). */
export function changedLines(change: Pick<ProposedChange, "ops">, result: ChangeResult | null | undefined): ChangedLine[] {
  const own = new Map((result?.lines ?? []).map((l) => [l.lineId, l]));
  return opLines(change.ops).map((l) => {
    const r = own.get(l.id);
    return { ...l, kind: CHANGED_LINE_KIND, result: r?.result ?? (result ? LINE_RESULT_FOR[result.result] : "skipped"), detail: r?.detail ?? "" };
  });
}

/** A line change's action as the author reads it. */
export const LINE_ACTION_LABELS: Record<ReplaceLine["action"], string> = { rewrite: "Rewrite", lead: "Move to top", trim: "Trim" };
const RESULT_LABELS: Record<LineResultKind, string> = { accepted: "Accepted", rejected: "Rejected", skipped: "Skipped" };

/**
 * Pure: every proposed line with its result, as an outcome table. Titled "Line
 * results", not "Changed lines": it lists rejected and skipped lines too, and
 * the checkpoint's "Changed lines" list (the accepted ones) sits above it.
 */
export function changedLinesTable(nodeId: string, lines: ChangedLine[]): OutcomeTable {
  return outcomeTable(
    nodeId,
    "Line results",
    [
      { key: "section", label: "Section" },
      { key: "change", label: "Change" },
      { key: "was", label: "Was" },
      { key: "now", label: "Now" },
      { key: "result", label: "Result" },
    ],
    lines.map((l) => ({
      cells: { section: l.heading, change: LINE_ACTION_LABELS[l.action], was: l.original, now: l.proposed, result: l.detail ? `${RESULT_LABELS[l.result]}: ${l.detail}` : RESULT_LABELS[l.result] },
      status: l.result,
      evidence: l.evidence,
    })),
  );
}

/** Pure: is there anything to apply? (replace_lines ops with no lines are nothing.) */
const hasContent = (ops: DocumentChangeOp[]) => ops.some((o) => o.op !== "replace_lines" || o.lines.length > 0);

/** Pure: a finding as a notes paragraph (title, detail, what it rests on). */
export function findingNote(f: Finding, workflow: string): string {
  const links = f.evidence.map((e) => `${e.label || e.ref}${e.page != null ? ` p.${e.page}` : ""}${e.kind === "web" ? ` (${e.ref})` : ""}${e.verified ? "" : " (unverified)"}`);
  return [`[${workflow}] ${f.title}`, f.detail.trim(), links.length ? `Rests on: ${links.join("; ")}` : "No linked passage."].filter(Boolean).join("\n");
}

export const docWrite: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as { target: "editor" | "section_notes"; title: string; snapshotReason: string; waitForResult?: boolean };
  const doc = await ctx.document();
  const id = node.node.id;
  if (config.target === "editor") {
    const ops = flattenOps(inputs.ops);
    if (!config.waitForResult) return { change: proposeChange(id, config, ops, doc.updated_at) };
    const result = ctx.run.changes?.[id];
    if (result) {
      // Resumed: the author applied or discarded the change; keep it as proposed.
      const kept = ctx.run.outputs[id]?.change as ProposedChange | undefined;
      const change = kept && Array.isArray(kept.ops) ? kept : proposeChange(id, config, ops, doc.updated_at);
      const all = changedLines(change, result);
      return { change, result, lines: all.filter((l) => l.result === "accepted"), table: changedLinesTable(id, all) };
    }
    if (!hasContent(ops)) {
      // Nothing to change: no card for the author, and no wait.
      const skipped: ChangeResult = { result: "skipped", by: "workflow_engine", at: new Date().toISOString(), detail: "Nothing to change." };
      return { result: skipped, lines: [], table: changedLinesTable(id, []) };
    }
    return { [WAIT_KEY]: true, change: proposeChange(id, config, ops, doc.updated_at) };
  }

  const findings = flat<Finding>(inputs.findings).filter((f) => isObj(f) && typeof f.title === "string");
  const sectionIds = new Set(listSections(doc.content_json).map((s) => s.sectionId).filter(Boolean));
  const bySection = new Map<string, Finding[]>();
  let skipped = 0;
  for (const f of findings) {
    const id = f.location?.sectionId;
    if (!id || !sectionIds.has(id)) {
      skipped++;
      continue;
    }
    bySection.set(id, [...(bySection.get(id) ?? []), f]);
  }
  let written = 0;
  for (const [sectionId, list] of bySection) {
    const prev = (await getSectionMeta(ctx.teamId, ctx.documentId, sectionId))?.notes ?? "";
    // A re-run doesn't append the same note twice.
    const add = list.map((f) => findingNote(f, ctx.run.workflow_name || "Workflow")).filter((n) => !prev.includes(n));
    if (!add.length) continue;
    await putSectionNotes(ctx.teamId, ctx.documentId, sectionId, { notes: [prev.trimEnd(), ...add].filter(Boolean).join("\n\n") });
    written += add.length;
  }
  return { change: { target: "section_notes", sections: bySection.size, written, skipped } };
};

// --- suggest.emit -------------------------------------------------------------------------

export const UNVERIFIED_PREFIX = "Unverified web resource: ";

/** Pure: gaps (sources and data only; elements are written, not gathered) and web resources as suggestion items. */
export function suggestionItems(gapsInput: unknown, resourcesInput: unknown): GeneratedItem[] {
  const items: GeneratedItem[] = [];
  for (const raw of flat(gapsInput)) {
    const [g] = asGaps(raw);
    const kind = isObj(raw) ? raw.kind : null;
    if (!g || (kind !== "source" && kind !== "data")) continue;
    const note = isObj(raw) && typeof raw.note === "string" ? raw.note.trim() : "";
    const why = g.heading ? `The ${g.heading} section needs this.` : "The document's type needs this.";
    items.push({ kind, label: g.need, reason: clip(note ? `${why} ${note}` : why, 500), spec_ref: g.specKey });
  }
  for (const r of flat<WebResource>(resourcesInput)) {
    if (!isObj(r) || typeof r.url !== "string" || typeof r.title !== "string") continue;
    items.push({ kind: "web", label: r.title, reason: clip(`${UNVERIFIED_PREFIX}${r.why || `for “${r.need}”`}`, 500), spec_ref: r.specKey ?? null, url: r.url });
  }
  return items;
}

export const suggestEmit: NodeHandler = async (inputs, _node, ctx) => {
  const items = suggestionItems(inputs.gaps, inputs.resources);
  const list = (await applyGenerated(ctx.teamId, ctx.agent, ctx.documentId, "coverage", items)) ?? [];
  return { suggestions: { open: list.filter((s) => s.state === "open").length, added: list.filter((s) => s.state === "added").length } };
};
