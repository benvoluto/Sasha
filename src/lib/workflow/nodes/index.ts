// Implementations of the document nodes and shared review steps declared in
// ../node-specs/steps.ts, by node type. The engine merges this map with its own
// nodes and ../generic/.
//
// CONTRACT (Phase 6): owned by the nodes-steps track. Every type in
// STEP_NODE_SPECS gets an entry; until it does, the engine fails that step
// with "no implementation".

import type { NodeHandler } from "../context";
import { stepAgree } from "./agree";
import { stepCheck } from "./check";
import { stepClassify } from "./classify";
import { typeCoverage } from "./coverage";
import { stepDecide } from "./decide";
import { stepExtract } from "./extract";
import { stepGate } from "./gate";
import { dataList, docNotes, docRead, requirementsRead, sourcesList, sourcesRead } from "./readers";
import { stepReview } from "./review";
import { rubricScore } from "./rubric";
import { stepSimulate } from "./simulate";
import { stepTrace } from "./trace";
import { webFind } from "./web-find";
import { docWrite, suggestEmit } from "./write";

export const STEP_HANDLERS: Record<string, NodeHandler> = {
  "doc.read": docRead,
  "doc.notes": docNotes,
  "sources.list": sourcesList,
  "sources.read": sourcesRead,
  "data.list": dataList,
  "requirements.read": requirementsRead,
  "type.coverage": typeCoverage,
  "web.find": webFind,
  "rubric.score": rubricScore,
  "step.gate": stepGate,
  "step.extract": stepExtract,
  "step.trace": stepTrace,
  "step.review": stepReview,
  "step.agree": stepAgree,
  "step.check": stepCheck,
  "step.classify": stepClassify,
  "step.simulate": stepSimulate,
  "step.decide": stepDecide,
  "doc.write": docWrite,
  "suggest.emit": suggestEmit,
};
