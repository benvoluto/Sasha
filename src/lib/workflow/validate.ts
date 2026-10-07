// Graph validation, run in the editor (to show problems on the canvas) and on
// the server (before saving and before running).

import { configFor, NODE_SPEC_INDEX, OUTPUT_NODE_TYPE, type NodeSpec } from "./registry";
import { templateVariables } from "./template";
import { portsCompatible, type GraphNode, type PortSpec, type WorkflowGraph } from "./types";

export type Issue = { severity: "error" | "warning"; message: string; nodeId?: string; edgeId?: string };

export type ResolvedNode = { node: GraphNode; spec: NodeSpec; config: Record<string, unknown>; inputs: PortSpec[]; outputs: PortSpec[] };

/** Each node with its parsed settings and current ports; unknown types are dropped. */
export function resolveNodes(graph: WorkflowGraph): Map<string, ResolvedNode> {
  const out = new Map<string, ResolvedNode>();
  for (const node of graph.nodes) {
    const spec = NODE_SPEC_INDEX[node.type];
    if (!spec) continue;
    const config = configFor(spec, node.config);
    out.set(node.id, { node, spec, config, inputs: spec.inputs(config), outputs: spec.outputs(config) });
  }
  return out;
}

/** Node ids in dependency order, or null when the graph has a cycle. */
export function topologicalOrder(graph: WorkflowGraph): string[] | null {
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue;
    indegree.set(e.target, indegree.get(e.target)! + 1);
    next.get(e.source)!.push(e.target);
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of next.get(id)!) {
      indegree.set(t, indegree.get(t)! - 1);
      if (indegree.get(t) === 0) queue.push(t);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/** Would adding source → target create a cycle? Used by the canvas while connecting. */
export function createsCycle(graph: WorkflowGraph, source: string, target: string): boolean {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  for (const e of graph.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

export function validateGraph(graph: WorkflowGraph): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) issues.push({ severity: "error", message: `Duplicate node id ${n.id}`, nodeId: n.id });
    ids.add(n.id);
    const spec = NODE_SPEC_INDEX[n.type];
    if (!spec) {
      issues.push({ severity: "error", message: `Unknown node type “${n.type}”`, nodeId: n.id });
      continue;
    }
    const parsed = spec.config.safeParse(n.config);
    if (!parsed.success) issues.push({ severity: "error", message: `${n.label || spec.label}: ${parsed.error.issues[0]?.path.join(".") || "settings"} ${parsed.error.issues[0]?.message}`, nodeId: n.id });
    if (n.loop && !spec.loopable) issues.push({ severity: "error", message: `${spec.label} cannot loop`, nodeId: n.id });
  }

  for (const spec of Object.values(NODE_SPEC_INDEX).filter((s) => s.single)) {
    const count = graph.nodes.filter((n) => n.type === spec.type).length;
    if (count > 1) issues.push({ severity: "error", message: `Only one ${spec.label} node is allowed` });
  }
  if (!graph.nodes.some((n) => n.type === OUTPUT_NODE_TYPE)) {
    issues.push({ severity: "error", message: "Add a Save output node so the run's result is recorded" });
  }

  const resolved = resolveNodes(graph);
  const incoming = new Map<string, number>();
  for (const e of graph.edges) {
    const s = resolved.get(e.source);
    const t = resolved.get(e.target);
    if (!s || !t) {
      issues.push({ severity: "error", message: "A connection points to a missing node", edgeId: e.id });
      continue;
    }
    const out = s.outputs.find((p) => p.name === e.sourceHandle);
    const inp = t.inputs.find((p) => p.name === e.targetHandle);
    if (!out || !inp) {
      issues.push({ severity: "error", message: `A connection into ${t.node.label || t.spec.label} uses a port that no longer exists`, edgeId: e.id, nodeId: t.node.id });
      continue;
    }
    if (!portsCompatible(out.type, inp.type)) {
      issues.push({ severity: "error", message: `${s.spec.label} “${out.label}” cannot connect to ${t.spec.label} “${inp.label}”`, edgeId: e.id });
    }
    const key = `${e.target}|${e.targetHandle}`;
    incoming.set(key, (incoming.get(key) ?? 0) + 1);
    if (!inp.multiple && incoming.get(key)! > 1) {
      issues.push({ severity: "error", message: `${t.node.label || t.spec.label} “${inp.label}” accepts one connection`, nodeId: t.node.id });
    }
  }

  for (const r of resolved.values()) {
    for (const inp of r.inputs) {
      if (!inp.optional && !incoming.get(`${r.node.id}|${inp.name}`)) {
        issues.push({ severity: "error", message: `${r.node.label || r.spec.label}: connect “${inp.label}”`, nodeId: r.node.id });
      }
    }
    const template = (r.config.prompt ?? r.config.template) as string | undefined;
    if (typeof template === "string") {
      const names = new Set(r.inputs.map((p) => p.name));
      for (const v of templateVariables(template)) {
        if (!names.has(v)) issues.push({ severity: "warning", message: `${r.node.label || r.spec.label}: {{${v}}} is not one of its inputs`, nodeId: r.node.id });
      }
    }
  }

  if (!topologicalOrder(graph)) issues.push({ severity: "error", message: "The workflow has a loop of connections; steps must flow one way" });
  return issues;
}
