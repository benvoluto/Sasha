// Turns a workflow definition (src/catalog/workflow-schema.ts: steps and their
// wiring, as data) into the graph the engine runs and the canvas shows. Pure
// and client-safe.
//
// - Each step's settings are its node type's defaults with the step's config
//   laid over them (top-level keys).
// - The outcome step takes the definition's outcome label and values, and its
//   requirement sets, notes and not-assessed list; a checkpoint step takes the
//   definition's checkpoint role. A step's own config wins where it sets them.
// - Positions: each step sits one row below the deepest step feeding it, and
//   steps in a row are spread left to right in definition order.
//
// CONTRACT (Phase 6): owned by the workflow-defs track.

import type { WorkflowDefinition } from "@/catalog/workflow-schema";
import { CHECKPOINT_NODE_TYPE, NODE_SPEC_INDEX, OUTPUT_NODE_TYPE } from "./registry";
import type { GraphEdge, GraphNode, WorkflowGraph } from "./types";

const COLUMN = 300;
const ROW = 200;

const refsOf = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
const split = (ref: string) => {
  const dot = ref.indexOf(".");
  return { step: ref.slice(0, dot), port: ref.slice(dot + 1) };
};

export function compileWorkflow(def: WorkflowDefinition): WorkflowGraph {
  // Rows: longest path from a step with no inputs (definitions are acyclic; a cycle leaves its steps on row 0 and fails validation).
  const row = new Map<string, number>();
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (row.has(id)) return row.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const step = byId.get(id);
    let d = 0;
    for (const refs of Object.values(step?.in ?? {})) for (const ref of refsOf(refs)) if (byId.has(split(ref).step)) d = Math.max(d, depth(split(ref).step) + 1);
    visiting.delete(id);
    row.set(id, d);
    return d;
  };
  def.steps.forEach((s) => depth(s.id));
  const column = new Map<number, number>();

  const nodes: GraphNode[] = def.steps.map((s) => {
    const r = row.get(s.id) ?? 0;
    const c = column.get(r) ?? 0;
    column.set(r, c + 1);
    const spec = NODE_SPEC_INDEX[s.node];
    const injected: Record<string, unknown> =
      s.node === OUTPUT_NODE_TYPE
        ? { label: def.outcome.label, values: def.outcome.values, requirementSets: def.requirementSets, notAssessed: def.notAssessed, notes: def.notes }
        : s.node === CHECKPOINT_NODE_TYPE && def.checkpoint
          ? { role: def.checkpoint.role }
          : {};
    return {
      id: s.id,
      type: s.node,
      ...(s.label ? { label: s.label } : {}),
      position: { x: c * COLUMN, y: r * ROW },
      config: { ...(spec ? (spec.defaults() as Record<string, unknown>) : {}), ...injected, ...s.config },
      loop: s.loop,
      expanded: false,
    };
  });

  const edges: GraphEdge[] = [];
  for (const s of def.steps) {
    for (const [port, refs] of Object.entries(s.in)) {
      for (const ref of refsOf(refs)) {
        const from = split(ref);
        edges.push({ id: `${from.step}.${from.port}->${s.id}.${port}`, source: from.step, sourceHandle: from.port, target: s.id, targetHandle: port });
      }
    }
  }
  return { format: "graph-v1", nodes, edges };
}
