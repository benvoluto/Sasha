// What a node implementation receives besides its inputs: the run, the team
// and document it is scoped to, the invocation's deadline, and memoized
// loaders so several nodes reading the document or its sources share one read.
// Server-only.
//
// CONTRACT (Phase 6): owned by the engine-core track; the nodes-steps and
// workflow-defs tracks write handlers against these types.

import type { DocumentTypeDefinition } from "@/catalog/schema";
import type { TypeWorkflowPolicy } from "@/catalog/workflow-schema";
import type { DocumentRecord } from "@/lib/documents/store";
import type { WorkflowRunRecord } from "./contract";
import type { ResolvedNode } from "./validate";

export type NodeContext = {
  run: WorkflowRunRecord;
  teamId: string;
  documentId: string;
  /** Who started the run (audit and model-call attribution). */
  agent: string;
  /**
   * Epoch ms by which this invocation must have stopped (function limit less a
   * margin). A long model call passes `deadlineMs: ctx.deadline - Date.now()`
   * (capped at its own limit) so it fails inside the function instead of
   * being cut off.
   */
  deadline: number;
  /** Run `load` once per invocation for `key`; later calls share the promise. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
  /** The document as stored (memoized). Throws NodeError when it is gone. */
  document(): Promise<DocumentRecord>;
  /** The document's effective type definition (team overrides applied), or null for a freeform document. */
  type(): Promise<DocumentTypeDefinition | null>;
  /** The type's workflow policy: sensitive (no document text leaves Sasha in web queries), web domains, draft-all. */
  policy(): Promise<TypeWorkflowPolicy>;
};

/** A node implementation: outputs by port name, or "wait" (checkpoints only). */
export type NodeHandler = (inputs: Record<string, unknown>, node: ResolvedNode, ctx: NodeContext) => Promise<Record<string, unknown> | "wait">;

/** A failure the step reports as its error; `raw` keeps a model reply that failed validation. */
export class NodeError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
  }
}
