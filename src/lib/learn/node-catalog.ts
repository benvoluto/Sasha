// The node types a learned workflow may use (PLAN §6.11: "a graph of the
// seven shared steps"), and their description for the extraction prompt,
// generated from NODE_SPEC_INDEX so the prompt always matches the registry:
// each node's ports and its settings as JSON Schema (input shape, so settings
// with defaults may be left out).
//
// Inputs (doc.read, sources.read, data.list, requirements.read), the shared
// review steps (step.*), rubric.score, type.coverage, and the engine's
// checkpoint and outcome. Nothing that writes to the document, searches the
// web or drafts: a learned workflow reviews, it never changes text.
//
// Client-safe (the registry is).

import { z } from "zod";
import { CHECKPOINT_NODE_TYPE, NODE_SPEC_INDEX, OUTPUT_NODE_TYPE, type NodeSpec } from "@/lib/workflow/registry";

const INPUT_NODES = ["doc.read", "sources.read", "data.list", "requirements.read"];
const EXTRA_NODES = ["rubric.score", "type.coverage", CHECKPOINT_NODE_TYPE, OUTPUT_NODE_TYPE];

/** Every allowed node type, in the order the prompt lists them. */
export const LEARN_NODE_TYPES: readonly string[] = [
  ...INPUT_NODES,
  ...Object.keys(NODE_SPEC_INDEX)
    .filter((t) => t.startsWith("step."))
    .sort(),
  ...EXTRA_NODES,
].filter((t) => NODE_SPEC_INDEX[t]);

const ALLOWED = new Set(LEARN_NODE_TYPES);
export const isLearnNode = (type: string) => ALLOWED.has(type);

function ports(list: ReturnType<NodeSpec["inputs"]>): string {
  if (!list.length) return "none";
  return list.map((p) => `${p.name}${p.optional ? "?" : ""}${p.multiple ? "[]" : ""}`).join(", ");
}

/** The settings' JSON Schema without the $schema line (it repeats on every node). */
function configSchema(spec: NodeSpec): string {
  const { $schema: _s, ...schema } = z.toJSONSchema(spec.config, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  void _s;
  return JSON.stringify(schema);
}

/** One block per allowed node: type, purpose, ports (with `?` optional and `[]` many) and settings schema. */
export function nodeCatalogText(): string {
  return LEARN_NODE_TYPES.map((type) => {
    const spec = NODE_SPEC_INDEX[type];
    const defaults = spec.defaults();
    return [
      `### ${type} (${spec.label})`,
      spec.description,
      `inputs: ${ports(spec.inputs(defaults))}; also "after" (ordering and gating only)`,
      `outputs: ${ports(spec.outputs(defaults))}`,
      `config schema: ${configSchema(spec)}`,
    ].join("\n");
  }).join("\n\n");
}
