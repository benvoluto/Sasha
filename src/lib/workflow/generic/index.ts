// Implementations of the compute step, the restructure and draft-all nodes and
// the resume Tailor step (tailor.lines) declared in ../node-specs/generic.ts,
// by node type. The engine merges this map with its own nodes and ../nodes/.
//
// CONTRACT (Phase 6): owned by the workflow-defs track. Every type in
// GENERIC_NODE_SPECS gets an entry.

import type { NodeHandler } from "../context";
import { computeHandler } from "./compute";
import { draftSectionHandler } from "./draft";
import { restructureApplyHandler, restructurePlanHandler, restructureRewriteHandler } from "./restructure-nodes";
import { tailorLinesHandler } from "./tailor";
import { TAILOR_NODE_TYPE } from "../node-specs/generic";

export const GENERIC_HANDLERS: Record<string, NodeHandler> = {
  "step.compute": computeHandler,
  "restructure.plan": restructurePlanHandler,
  "restructure.apply": restructureApplyHandler,
  "restructure.rewrite": restructureRewriteHandler,
  "draft.section": draftSectionHandler,
  [TAILOR_NODE_TYPE]: tailorLinesHandler,
};
