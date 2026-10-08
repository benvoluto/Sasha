// The node library. Each node type declares its settings (validated with zod),
// its input and output ports (which may depend on its settings, e.g. one output
// per extracted field), and whether it can loop over lists. Shared by the canvas
// and the engine; the specs live under node-specs/ by owner and are merged
// here, and the engine's implementations are in core-nodes.ts, nodes/ and generic/
// (merged in engine.ts).

import { CORE_NODE_SPECS } from "./node-specs/core";
import { GENERIC_NODE_SPECS } from "./node-specs/generic";
import { STEP_NODE_SPECS } from "./node-specs/steps";
import type { NodeSpec } from "./node-spec";

export { CATEGORIES, PortName, type Category, type NodeSpec } from "./node-spec";
export { CHECKPOINT_NODE_TYPE, LEGACY_NODE_TYPES, OUTPUT_NODE_TYPE } from "./node-specs/core";

export const NODE_SPECS: NodeSpec[] = [...STEP_NODE_SPECS, ...GENERIC_NODE_SPECS, ...CORE_NODE_SPECS];

export const NODE_SPEC_INDEX: Record<string, NodeSpec> = Object.fromEntries(NODE_SPECS.map((s) => [s.type, s]));

/** A node's settings parsed against its type, or the defaults when they don't parse. */
export function configFor(spec: NodeSpec, config: unknown): Record<string, unknown> {
  const r = spec.config.safeParse(config);
  return (r.success ? r.data : spec.defaults()) as Record<string, unknown>;
}
