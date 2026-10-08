// What a node type declares: its settings (validated with zod), its input and
// output ports (which may depend on its settings), and how the engine may run
// it. The node library is split by owner under node-specs/ and merged in
// registry.ts. Client-safe.
//
// CONTRACT (Phase 6): port names and config shapes are shared by the engine,
// the node implementations, the workflow definitions and the canvas.

import { z } from "zod";
import { modelForTier } from "@/lib/llm/tasks";
import type { PortSpec } from "./types";

export type Category = "Inputs" | "Review steps" | "Changes" | "Flow" | "AI" | "Text & logic";
export const CATEGORIES: Category[] = ["Inputs", "Review steps", "Changes", "Flow", "AI", "Text & logic"];

export type NodeSpec<C = Record<string, unknown>> = {
  type: string;
  category: Category;
  label: string;
  description: string;
  config: z.ZodType<C>;
  defaults: () => C;
  inputs: (config: C) => PortSpec[];
  outputs: (config: C) => PortSpec[];
  loopable?: boolean;
  /** At most one per workflow. */
  single?: boolean;
  /**
   * Don't start the node (or, looping, its next item) unless this much of the
   * invocation's time is left; the run pauses instead and continuing resumes
   * it. For long model calls (Opus drafting streams for up to 270 s).
   */
  minTimeMs?: number;
  /** Looping: at most this many items at once (default: the engine's LOOP_CONCURRENCY). */
  maxConcurrency?: number;
};

/** Port and variable names: lowercase, starting with a letter. */
export const PortName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and _; start with a letter");

/** Keys inside node settings (criteria, checks, reviewers): snake_case. */
export const ConfigKey = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, "snake_case");

export const defaultModel = (temperature = 0.3) => ({ provider: "anthropic" as const, model: modelForTier("mid"), temperature });

export function spec<C extends Record<string, unknown>>(s: NodeSpec<C>): NodeSpec {
  return s as unknown as NodeSpec;
}

export const nameList = z.array(PortName).max(10).refine((a) => new Set(a).size === a.length, "names must be unique");

/** A json input port that is optional (most review-step inputs). */
export const optionalJson = (name: string, label = name, multiple = false): PortSpec => ({ name, label, type: "json", optional: true, ...(multiple ? { multiple: true } : {}) });

/**
 * Every node also accepts `after`: connections that only order and gate it.
 * The node starts once they settle and is skipped unless each delivered a
 * value (a gate's `pass`, a checkpoint's `approved`); the values are not passed
 * to the implementation. resolveNodes adds it to each node's inputs.
 */
export const AFTER_PORT: PortSpec = { name: "after", label: "after", type: "any", multiple: true, optional: true };
