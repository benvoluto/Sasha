// The change nodes. doc.write proposes document changes for the open editor
// to apply (as one undo step after a snapshot) and never writes the body
// itself; with target "section_notes" it appends findings to section notes,
// which leaves the body untouched. suggest.emit turns coverage gaps and web
// resources into suggestions (origin "coverage"), web ones marked unverified.

import { getSectionMeta, putSectionNotes } from "@/lib/documents/section-store";
import { listSections } from "@/lib/documents/sections";
import { applyGenerated } from "@/lib/suggestions/store";
import type { GeneratedItem } from "@/lib/suggestions/diff";
import type { DocumentChangeOp, Finding, ProposedChange } from "../contract";
import type { NodeHandler } from "../context";
import { asGaps } from "./web-find";
import { clip, flat } from "./util";
import type { WebResource } from "./types";

// --- doc.write ------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOp = (v: unknown): v is DocumentChangeOp => isObj(v) && (v.op === "restructure" || v.op === "replace_section_body");

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
  return parts.length ? `${parts.join(", and ")}.` : "No changes.";
}

/** Pure: the change the editor will apply. */
export function proposeChange(nodeId: string, config: { title: string; snapshotReason: string }, ops: DocumentChangeOp[], basisUpdatedAt: string): ProposedChange {
  return { id: nodeId, title: config.title, summary: summarizeOps(ops), ops, basisUpdatedAt, snapshotReason: config.snapshotReason };
}

/** Pure: a finding as a notes paragraph (title, detail, what it rests on). */
export function findingNote(f: Finding, workflow: string): string {
  const links = f.evidence.map((e) => `${e.label || e.ref}${e.page != null ? ` p.${e.page}` : ""}${e.kind === "web" ? ` (${e.ref})` : ""}${e.verified ? "" : " (unverified)"}`);
  return [`[${workflow}] ${f.title}`, f.detail.trim(), links.length ? `Rests on: ${links.join("; ")}` : "No linked passage."].filter(Boolean).join("\n");
}

export const docWrite: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as { target: "editor" | "section_notes"; title: string; snapshotReason: string };
  const doc = await ctx.document();
  if (config.target === "editor") return { change: proposeChange(node.node.id, config, flattenOps(inputs.ops), doc.updated_at) };

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
