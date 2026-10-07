// The starting workflow: the source documents go to one model prompt that
// summarizes them and lists gaps, and its answer is saved as the run's result.

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

/** The built-in summary prompt; {{sources}} is the combined source text. */
export const DEFAULT_SUMMARY_PROMPT = `Summarize these sources and list gaps: topics, evidence or data they do not cover.

Sources:
{{sources}}`;

export function defaultWorkflowGraph(): WorkflowGraph {
  return {
    format: "graph-v1",
    nodes: [
      node("sources", "source.documents", 0, 0),
      node("summarize", "ai.ask", 0, 200, {
        label: "Summarize and list gaps",
        config: { ...NODE_SPEC_INDEX["ai.ask"].defaults(), prompt: DEFAULT_SUMMARY_PROMPT, inputs: ["sources"] },
      }),
      node("output", "output.save", 0, 400),
    ],
    edges: [edge("sources", "combined", "summarize", "sources"), edge("summarize", "response", "output", "text")],
  };
}
