// The workflow graph: nodes from the node library, wired output → input.
// Shared by the canvas (client) and the engine (server); no server imports here.

import { z } from "zod";

export const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const GraphNode = z.object({
  id: NodeId,
  type: z.string().min(1),
  /** Display name; defaults to the node type's label. */
  label: z.string().max(80).optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Run once per item when an input carries a list (loopable nodes only). */
  loop: z.boolean().default(false),
  /** Canvas-only: whether the node's settings are shown on the card. */
  expanded: z.boolean().default(false),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string().min(1),
  source: NodeId,
  sourceHandle: z.string().min(1),
  target: NodeId,
  targetHandle: z.string().min(1),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const WorkflowGraph = z.object({
  format: z.literal("graph-v1"),
  nodes: z.array(GraphNode).max(60),
  edges: z.array(GraphEdge).max(200),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

/**
 * Port value types. `text` accepts anything (objects are serialized to JSON),
 * `any` passes values through unchanged, and `json` connects only to inputs
 * that accept text, any value, or JSON.
 */
export type PortType = "text" | "any" | "json";

export type PortSpec = {
  name: string;
  label: string;
  type: PortType;
  /** Inputs only: accepts several incoming connections, delivered as a list. */
  multiple?: boolean;
  /** Inputs only: the node can run without it. */
  optional?: boolean;
  /** Outputs only: the value is a list (loop mode on the next node iterates it). */
  list?: boolean;
};

/**
 * Can an output of type `from` connect to an input of type `to`? Pass-through
 * outputs (`any`, e.g. a human checkpoint or a branch) connect anywhere; the
 * receiving node validates the actual value at run time.
 */
export function portsCompatible(from: PortType, to: PortType): boolean {
  if (to === "any" || to === "text" || from === "any") return true;
  return from === to;
}
