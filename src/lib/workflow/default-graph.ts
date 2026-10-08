// The starting graph for a new team workflow on the canvas: the linked
// sources' passages go to one model prompt that summarizes them and lists
// gaps, and its answer becomes the outcome's summary.

import { NODE_SPEC_INDEX } from "./registry";
import type { GraphEdge, GraphNode, WorkflowGraph } from "./types";

const node = (id: string, type: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  position: { x, y },
  config: NODE_SPEC_INDEX[type].defaults(),
  loop: false,
  expanded: false,
  ...extra,
});

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}.${sourceHandle}->${target}.${targetHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

/** The built-in summary prompt; {{sources}} is the sources block with passage ids. */
export const DEFAULT_SUMMARY_PROMPT = `Summarize these sources and list gaps: topics, evidence or data they do not cover.

Sources:
{{sources}}`;

export function defaultWorkflowGraph(): WorkflowGraph {
  return {
    format: "graph-v1",
    nodes: [
      node("sources", "sources.read", 0, 0),
      node("summarize", "ai.ask", 0, 200, {
        label: "Summarize and list gaps",
        config: { ...NODE_SPEC_INDEX["ai.ask"].defaults(), prompt: DEFAULT_SUMMARY_PROMPT, inputs: ["sources"] },
      }),
      node("outcome", "outcome.report", 0, 400),
    ],
    edges: [edge("sources", "text", "summarize", "sources"), edge("summarize", "response", "outcome", "summary")],
  };
}
