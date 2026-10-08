// web.find (phase6-spec.md §4.3): public web resources for coverage gaps, found
// with the server web search tool. For a sensitive type (student records,
// clinical notes) no document text goes out at all: the query carries only the
// gap labels and section headings from the type definition, and searches only
// the type's public domains. Results are kept only when their URL was really
// returned by a search, is http(s), and sits within the allowed domains; every
// resource stays unverified until a person adds it.

import type { BetaWebSearchTool20250305 } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import type { TypeWorkflowPolicy } from "@/catalog/workflow-schema";
import { claudeSearch } from "@/lib/llm/claude";
import { safeUrl } from "@/lib/suggestions/store";
import type { Finding } from "../contract";
import { NodeError, type NodeHandler } from "../context";
import { WEB_SYSTEM, defuseAll, tagBlock } from "./prompts";
import { coverageNeeds } from "./coverage";
import { asDoc, callOpts, clip, Findings, flat } from "./util";
import type { DocSnapshot, WebResource } from "./types";

export type WebConfig = { maxResults: number; maxSearches: number; allowedDomains: string[]; blockedDomains: string[] };
export type Gap = { id: string; need: string; specKey: string | null; heading: string | null };
export type WebQuery = { sensitive: boolean; gaps: Gap[]; user: string; allowed: string[]; blocked: string[] };

export const NOT_SET_UP = "web search is not set up for this type";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The gaps input (CoverageRow or anything with a `need` label). */
export function asGaps(v: unknown): Array<{ need: string; specKey: string | null; heading: string | null }> {
  return flat(v)
    .filter((g): g is Record<string, unknown> => isObj(g) && typeof g.need === "string" && !!g.need.trim())
    .map((g) => ({ need: String(g.need).trim(), specKey: typeof g.specKey === "string" ? g.specKey : null, heading: typeof g.heading === "string" ? g.heading : null }));
}

const host = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

/**
 * Pure: what web.find may send. Sensitive: only gaps whose label is one of the
 * type's own needs (catalog text), headings from the type definition, and the
 * policy's domains (none: refuse). Otherwise the document and type titles and
 * the gaps, with the config's domains (policy domains added to the allowed list).
 */
export function webQuery(policy: TypeWorkflowPolicy, def: Pick<DocumentTypeDefinition, "title" | "sections"> | null, doc: Pick<DocSnapshot, "title"> | null, rawGaps: ReturnType<typeof asGaps>, config: WebConfig): WebQuery {
  const sensitive = policy.sensitive;
  let gaps: Gap[];
  if (sensitive) {
    if (!policy.webDomains.length) throw new NodeError(NOT_SET_UP);
    const needs = def ? coverageNeeds(def, true) : [];
    const known = new Map(needs.map((n) => [n.need.toLowerCase(), n]));
    gaps = rawGaps.flatMap((g) => {
      const n = known.get(g.need.toLowerCase());
      return n ? [{ id: "", need: n.need, specKey: n.specKey, heading: n.heading }] : [];
    });
  } else {
    gaps = rawGaps.map((g) => ({ id: "", ...g }));
  }
  const seen = new Set<string>();
  gaps = gaps.filter((g) => !seen.has(g.need.toLowerCase()) && !!seen.add(g.need.toLowerCase())).slice(0, 20).map((g, i) => ({ ...g, id: `G${i + 1}` }));
  const allowed = sensitive ? policy.webDomains.map(host) : [...new Set([...config.allowedDomains, ...(config.allowedDomains.length ? policy.webDomains : [])].map(host).filter(Boolean))];
  const blocked = sensitive || allowed.length ? [] : [...new Set(config.blockedDomains.map(host).filter(Boolean))];
  const lines = gaps.map((g) => `- ${g.id}: ${g.need}${g.heading ? ` (for the section “${g.heading}”)` : ""}`);
  const out: string[] = [];
  if (sensitive) out.push(`A ${def?.title ?? "document"} needs public reference material. Find official guidance for these needs. Search only public sources; there is no case information here, and none is needed.`);
  else out.push(`Document: “${clip(doc?.title || "Untitled", 200)}”${def ? `, a ${def.title}` : ""}. Find public resources for the gaps in its sources.`);
  out.push(tagBlock("gaps", defuseAll(lines.join("\n"))));
  if (allowed.length) out.push(`Search only these sites: ${allowed.join(", ")}.`);
  out.push(`Return at most ${config.maxResults} resources.`);
  return { sensitive, gaps, user: out.join("\n\n"), allowed, blocked };
}

/** Pure: the server tool definition. */
export function searchTool(q: Pick<WebQuery, "allowed" | "blocked">, maxSearches: number): BetaWebSearchTool20250305 {
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxSearches,
    ...(q.allowed.length ? { allowed_domains: q.allowed } : q.blocked.length ? { blocked_domains: q.blocked } : {}),
  };
}

export const WebModelOutput = z.object({ resources: z.array(z.object({ url: z.string(), title: z.string(), publisher: z.string(), why: z.string(), gap: z.string() })) });
export type WebModelOutput = z.infer<typeof WebModelOutput>;

const canon = (u: string) => {
  const s = safeUrl(u);
  if (!s) return null;
  const url = new URL(s);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

export function withinDomains(url: string, allowed: string[], blocked: string[]): boolean {
  const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const under = (d: string) => h === d || h.endsWith(`.${d}`);
  if (allowed.length && !allowed.some(under)) return false;
  return !blocked.some(under);
}

/** Pure: resources whose URL a search returned, that are http(s), within the domains and for a known gap. All unverified. */
export function filterResources(reply: WebModelOutput, searchedUrls: string[], q: WebQuery, maxResults: number): WebResource[] {
  const searched = new Set(searchedUrls.map(canon).filter((u): u is string => !!u));
  const gaps = new Map(q.gaps.map((g) => [g.id, g]));
  const out: WebResource[] = [];
  for (const r of reply.resources) {
    const url = safeUrl(r.url.trim());
    const key = url && canon(url);
    const gap = gaps.get(r.gap.trim());
    if (!url || !key || !searched.has(key) || !gap || !withinDomains(url, q.allowed, q.blocked) || out.some((o) => canon(o.url) === key)) continue;
    out.push({ url, title: clip(r.title.trim() || url, 300), publisher: clip(r.publisher.trim(), 200), why: clip(r.why.trim(), 500), need: gap.need, specKey: gap.specKey, verified: false });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function webFindings(nodeId: string, resources: WebResource[]): Finding[] {
  const f = new Findings(nodeId);
  for (const r of resources)
    f.add({
      kind: "web_resource",
      severity: "info",
      title: `Possible resource for “${r.need}”: ${r.title}`,
      detail: `${r.why}${r.publisher ? ` (${r.publisher})` : ""} Unverified until you add it.`,
      evidence: [{ kind: "web", ref: r.url, sourceId: null, label: r.title, quote: "", page: null, stance: "neutral", verified: false }],
      verified: false,
    });
  return f.list();
}

export const webFind: NodeHandler = async (inputs, node, ctx) => {
  const config = node.config as WebConfig;
  const policy = await ctx.policy();
  const rawGaps = asGaps(inputs.gaps);
  // Sensitive: the document snapshot is never read, so none of its text can reach the query.
  const q = webQuery(policy, await ctx.type(), policy.sensitive ? null : asDoc(inputs.document), rawGaps, config);
  if (!q.gaps.length) return { resources: [], findings: [] };
  const { data, searchedUrls } = await claudeSearch({ task: "web.find", system: WEB_SYSTEM, user: q.user, schema: WebModelOutput, tools: [searchTool(q, config.maxSearches)], ...callOpts(ctx) });
  const resources = filterResources(data, searchedUrls, q, config.maxResults);
  return { resources, findings: webFindings(node.node.id, resources) };
};
