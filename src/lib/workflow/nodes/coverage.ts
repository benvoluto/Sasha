// type.coverage: how well the linked sources and data (and, for required
// elements, the document's own text) cover what the type needs. Each need is
// supported, weak or missing, with the passages behind it. Weak and missing
// needs become gaps (for web.find and suggest.emit) and findings.

import { z } from "zod";
import { sortedSections, type DocumentTypeDefinition } from "@/catalog/schema";
import { claudeJson } from "@/lib/llm/claude";
import { typeNeeds } from "@/lib/suggestions/diff";
import type { Finding } from "../contract";
import { NodeError, type NodeHandler } from "../context";
import { COVERAGE_SYSTEM, dataBlock, documentBlock, sourcesBlock } from "./prompts";
import { asDoc, asSources, asTables, callOpts, EvidenceIndex, Findings, outcomeTable } from "./util";
import type { CoverageRow, DocSnapshot, SourcesSnapshot, TableView } from "./types";

export type Need = { id: string; need: string; kind: CoverageRow["kind"]; specKey: string | null; heading: string | null };

/** At most this many needs are scored (typeNeeds caps sources and data at 40). */
export const MAX_NEEDS = 80;

/** Pure: the type's sources and data needed (typeNeeds) then, with includeElements, each section's required elements. Catalog text only. */
export function coverageNeeds(def: Pick<DocumentTypeDefinition, "sections">, includeElements: boolean): Need[] {
  const headings = new Map(def.sections.map((s) => [s.key, s.heading]));
  const out: Need[] = typeNeeds(def).map((n) => ({ id: "", need: n.label, kind: n.kind === "data" ? "data" : "source", specKey: n.spec_ref, heading: n.spec_ref ? (headings.get(n.spec_ref) ?? null) : null }));
  if (includeElements) for (const s of sortedSections(def.sections)) for (const e of s.elements) out.push({ id: "", need: e, kind: "element", specKey: s.key, heading: s.heading });
  return out.slice(0, MAX_NEEDS).map((n, i) => ({ ...n, id: `N${i + 1}` }));
}

export const CoverageModelOutput = z.object({
  rows: z.array(z.object({ need: z.string(), status: z.enum(["supported", "weak", "missing"]), evidence: z.array(z.object({ id: z.string(), quote: z.string() })), note: z.string() })),
});
export type CoverageModelOutput = z.infer<typeof CoverageModelOutput>;

export function coverageUserPrompt(needs: Need[], m: { doc: DocSnapshot | null; sources: SourcesSnapshot | null; tables: TableView[] }): string {
  const out: string[] = [];
  out.push(["Needs (id [kind] need; section):", ...needs.map((n) => `- ${n.id} [${n.kind}] ${n.need}${n.heading ? `; ${n.heading}` : ""}`)].join("\n"));
  out.push(sourcesBlock(m.sources));
  out.push(dataBlock(m.tables));
  if (m.doc && needs.some((n) => n.kind === "element")) out.push(documentBlock(m.doc));
  return out.join("\n\n");
}

/** Pure: one row per need. Unknown need ids are dropped, an unscored need is missing, and a supported or weak need with no checkable evidence is missing. */
export function buildCoverage(reply: CoverageModelOutput, needs: Need[], index: EvidenceIndex): CoverageRow[] {
  // Rows name a need by its id, or (as models sometimes do) by its exact label.
  const ids = new Map(needs.flatMap((n) => [[n.id.toLowerCase(), n.id], [n.need.toLowerCase(), n.id]]));
  const byId = new Map<string, CoverageModelOutput["rows"][number]>();
  for (const r of reply.rows) {
    const id = ids.get(r.need.trim().toLowerCase());
    if (id && !byId.has(id)) byId.set(id, r);
  }
  return needs.map((n) => {
    const base = { need: n.need, kind: n.kind, specKey: n.specKey, heading: n.heading };
    const r = byId.get(n.id);
    if (!r) return { ...base, status: "missing" as const, evidence: [], note: "Not scored." };
    const evidence = index.links(r.evidence, "for");
    if (r.status !== "missing" && !evidence.length) return { ...base, status: "missing" as const, evidence: [], note: `${r.note} (No checkable support was cited.)`.trim() };
    return { ...base, status: r.status, evidence, note: r.note };
  });
}

export function coverageFindings(nodeId: string, rows: CoverageRow[]): Finding[] {
  const f = new Findings(nodeId);
  for (const r of rows) {
    if (r.status === "supported") continue;
    f.add({
      kind: "coverage_gap",
      severity: r.status === "weak" ? "minor" : "major",
      status: r.status,
      title: `${r.status === "weak" ? "Weakly supported" : "Missing"}: ${r.need}`,
      detail: r.note,
      location: r.specKey || r.heading ? { sectionId: null, specKey: r.specKey, heading: r.heading, quote: "" } : null,
      evidence: r.evidence,
    });
  }
  return f.list();
}

export function coverageTable(nodeId: string, rows: CoverageRow[]) {
  const label = { supported: "Supported", weak: "Weak", missing: "Missing" };
  return outcomeTable(
    nodeId,
    "Source coverage",
    [
      { key: "need", label: "Need" },
      { key: "kind", label: "Kind" },
      { key: "section", label: "Section" },
      { key: "status", label: "Status" },
      { key: "note", label: "Note" },
    ],
    rows.map((r) => ({ cells: { need: r.need, kind: r.kind, section: r.heading ?? "", status: label[r.status], note: r.note }, status: r.status, evidence: r.evidence })),
  );
}

export const typeCoverage: NodeHandler = async (inputs, node, ctx) => {
  const { includeElements } = node.config as { includeElements: boolean };
  const def = await ctx.type();
  if (!def) throw new NodeError("source coverage needs a document type");
  const m = { doc: asDoc(inputs.document), sources: asSources(inputs.sources), tables: asTables(inputs.data) };
  const needs = coverageNeeds(def, includeElements);
  const id = node.node.id;
  if (!needs.length) return { coverage: [], gaps: [], findings: [], table: coverageTable(id, []) };
  const index = new EvidenceIndex({ doc: m.doc, sources: m.sources, tables: m.tables });
  const { data } = await claudeJson({ task: "coverage.score", system: COVERAGE_SYSTEM, user: coverageUserPrompt(needs, m), schema: CoverageModelOutput, ...callOpts(ctx) });
  const coverage = buildCoverage(data, needs, index);
  return { coverage, gaps: coverage.filter((r) => r.status !== "supported"), findings: coverageFindings(id, coverage), table: coverageTable(id, coverage) };
};
