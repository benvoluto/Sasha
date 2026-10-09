// Shapes for Phase 6 workflows (PLAN decision 11, §4.3, §6.7, and the per-type
// specs in docs/workflows-by-document-type.md): runs scoped to a document,
// findings that link to the passage or source they rest on, independent
// reviews and their agreement, outcomes with fixed values, human checkpoints,
// and document changes the open editor applies. Client-safe (zod, types and
// pure helpers only).
//
// CONTRACT (Phase 6): see phase6-spec.md. Shared by the engine-core,
// nodes-steps, workflow-defs and workflows-ui tracks. Change a shape only with
// every consumer updated in the same change.

import { z } from "zod";
import { WorkflowGraph } from "./types";

// --- Limits ---------------------------------------------------------------------

/** The function limit runs execute under (route maxDuration). */
export const FUNCTION_LIMIT_MS = 300_000;
/** Findings kept per node, and per outcome. */
export const MAX_FINDINGS = 200;
export const MAX_EVIDENCE = 12;
export const MAX_QUOTE_CHARS = 600;
/** Independent review: two or three reviewers, each with a different brief. */
export const MIN_REVIEWERS = 2;
export const MAX_REVIEWERS = 3;
/** Runs listed in a document's history. */
export const MAX_RUN_HISTORY = 50;

// --- Runs -------------------------------------------------------------------------

export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped", "waiting"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export type StepState = {
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  note?: string;
  /** A looping node's progress, kept across pauses. */
  progress?: { done: number; total: number; items?: StepProgressItem[] };
};

/** Loop items listed on a step (the first MAX_PROGRESS_ITEMS), so the Workflows tab can show each section's state. */
export const MAX_PROGRESS_ITEMS = 60;
export const PROGRESS_ITEM_STATES = ["pending", "running", "done", "failed", "skipped"] as const;
export type StepProgressItem = { label: string; state: (typeof PROGRESS_ITEM_STATES)[number]; sectionId?: string };

/**
 * running: executing now. awaiting_review: stopped at a human checkpoint.
 * paused: stopped at the time budget (continue resumes it). complete: the
 * outcome node ran. failed: finished without an outcome. superseded: a later
 * run of the same workflow on the same document replaced it.
 * ("draft" in rows from before Phase 6 reads as "complete".)
 */
export const RUN_STATUSES = ["running", "awaiting_review", "paused", "complete", "failed", "superseded"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: RunStatus[] = ["running", "awaiting_review", "paused"];

/** Why a run paused: the invocation's time budget (the Workflows tab continues it on its own), or a person. */
export type PauseReason = "budget" | "manual";

/** Per-run inputs a workflow declares in `params` (restructure: the target type and mode). */
export const RunParams = z.strictObject({
  targetType: z.string().min(2).max(80).optional(),
  mode: z.enum(["merge", "rewrite"]).optional(),
  /** Policy notices the person acknowledged to start the run (e.g. "draft-all-policy" for NIH). */
  acknowledge: z.array(z.string().max(60)).max(5).optional(),
});
export type RunParams = z.infer<typeof RunParams>;

// --- Evidence and findings ----------------------------------------------------------

/**
 * What a finding rests on.
 * - passage: ref "S<8 hex>.P<n>" (source_passage.id), sourceId set.
 * - source: ref = source uuid (no passage could be pinned).
 * - data: ref = data table uuid, optionally "#r<row>" appended.
 * - document: ref = a section id in the document, or "doc".
 * - note: ref "notes" (the scratchpad) or a section id (its section notes).
 * - requirement: ref "<set key>#<item key>" (src/catalog/requirements/).
 * - web: ref = URL (always unverified until a person accepts it).
 * - item: ref = an extracted item id ("I3") within the run.
 */
export const EVIDENCE_KINDS = ["passage", "source", "data", "document", "note", "requirement", "web", "item"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EvidenceLink = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  ref: z.string().min(1).max(500),
  sourceId: z.string().max(80).nullable().default(null),
  /** Display text: source title, section heading, requirement title. */
  label: z.string().max(300).default(""),
  quote: z.string().max(MAX_QUOTE_CHARS).default(""),
  page: z.number().int().nullable().default(null),
  stance: z.enum(["for", "against", "neutral"]).default("neutral"),
  /** False when the link could not be checked against stored text (quote not found, simulated, no code access, web). */
  verified: z.boolean().default(true),
});
export type EvidenceLink = z.output<typeof EvidenceLink>;

/** Where in the document a finding or item sits. `quote` is checked against the document text. */
export const DocLocation = z.object({
  sectionId: z.string().max(64).nullable().default(null),
  specKey: z.string().max(80).nullable().default(null),
  heading: z.string().max(300).nullable().default(null),
  quote: z.string().max(MAX_QUOTE_CHARS).default(""),
});
export type DocLocation = z.output<typeof DocLocation>;

export const SEVERITIES = ["blocking", "major", "minor", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const Finding = z.object({
  /** Unique within the run: "<nodeId>:<n>". */
  id: z.string().min(1).max(120),
  nodeId: z.string().min(1).max(64),
  /** What kind of problem, snake_case: unsupported_claim, page_limit, untestable_requirement, walkthrough_failed, gap… */
  kind: z.string().min(1).max(60),
  severity: z.enum(SEVERITIES),
  /** The step's status for the item, when it has one (overstated, not_met, unsupported…). */
  status: z.string().max(60).nullable().default(null),
  title: z.string().min(1).max(300),
  detail: z.string().max(2000).default(""),
  location: DocLocation.nullable().default(null),
  /** Every finding links to what it rests on; one with none is shown as "No linked passage". */
  evidence: z.array(EvidenceLink).max(MAX_EVIDENCE).default([]),
  /** The reviewer key for review findings. */
  reviewer: z.string().max(60).nullable().default(null),
  /** False for model judgement nobody could check (simulated walkthrough, claims about code with no access, web). */
  verified: z.boolean().default(true),
  /** A suggested fix, when the step proposes one. */
  fix: z.string().max(1000).default(""),
});
export type Finding = z.output<typeof Finding>;

/** The author's response to a finding (workflows with no checkpoint: accept or dismiss each). */
export const FINDING_RESPONSES = ["open", "accepted", "dismissed"] as const;
export type FindingResponseState = (typeof FINDING_RESPONSES)[number];
export type FindingResponse = { state: FindingResponseState; by: string; at: string };

// --- Tables shown with an outcome -----------------------------------------------------

/** A table for the outcome view: an evidence table, a compliance matrix, an options matrix, a mapping table. */
export const OutcomeTable = z.object({
  key: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  columns: z.array(z.object({ key: z.string().min(1).max(60), label: z.string().max(120) })).min(1).max(20),
  rows: z
    .array(
      z.object({
        cells: z.record(z.string(), z.string().max(2000)),
        status: z.string().max(60).nullable().default(null),
        evidence: z.array(EvidenceLink).max(MAX_EVIDENCE).default([]),
      }),
    )
    .max(500),
});
export type OutcomeTable = z.output<typeof OutcomeTable>;

// --- Shared-step outputs ------------------------------------------------------------------

/** step.gate: each required input and whether it was found. */
export type GateItem = { key: string; label: string; required: boolean; present: boolean; how: "keyword" | "model" | "none"; evidence: EvidenceLink[]; help: string };
export type GateReport = { items: GateItem[]; missing: GateItem[] };

/** step.extract: one structured item. Field values are strings, numbers, booleans, string lists or null. */
export type FieldValue = string | number | boolean | string[] | null;
export type ExtractedItem = { id: string; fields: Record<string, FieldValue>; location: DocLocation | null; evidence: EvidenceLink[] };

/** step.trace: an item with its support status and links. */
export type TracedItem = ExtractedItem & { status: string; rationale: string; linkedTargets: string[] };

/** step.compute: one deterministic check. ok null = could not compute (inputs missing). */
export type ComputeResult = {
  key: string;
  label: string;
  ok: boolean | null;
  expected: string;
  actual: string;
  detail: string;
  /** True for estimates (page counts from words, school days without a school calendar). */
  approximate: boolean;
  evidence: EvidenceLink[];
};

/** step.check: one checklist answer (per document, or per item when perItem). */
export type CheckResult = { check: string; label: string; itemId: string | null; status: string; rationale: string; evidence: EvidenceLink[] };

/** step.classify: one unit (paragraph or item) and its category. */
export type ClassifiedUnit = { unitId: string; sectionId: string | null; excerpt: string; category: string; rationale: string };

/** step.simulate: a walkthrough, dry run or explain-back. Always simulated (no sandbox), so unverified. */
export type SimulationStep = { step: string; stated: string; observed: string; ok: boolean; note: string; location: DocLocation | null };
export type SimulationLog = { persona: string; steps: SimulationStep[]; stoppedAt: string | null; executed: false };

// --- Independent review and agreement ----------------------------------------------------

export type Rating = { item: string; verdict: string | null; score: number | null; rationale: string; evidence: EvidenceLink[] };
export type ReviewNote = { text: string; evidence: EvidenceLink[] };
export type Review = { reviewer: string; label: string; brief: string; ratings: Rating[]; strengths: ReviewNote[]; weaknesses: ReviewNote[]; round: 1 | 2 };

export type ReviewerPosition = { reviewer: string; label: string; brief: string; verdict: string | null; score: number | null; rationale: string; evidence: EvidenceLink[] };
/** Reviewers agreed on an item (score mode: within tolerance). Positions are kept; nothing is averaged. */
export type AgreedItem = { item: string; label: string; verdict: string | null; positions: ReviewerPosition[] };
/** Reviewers differed on an item. Both (all) rationales are shown; nothing is resolved by averaging. */
export type Disagreement = { id: string; nodeId: string; item: string; label: string; positions: ReviewerPosition[]; blocking: boolean };
/** Score items: summary statistics reported alongside (NIH reports the median, the range and the mean × 10). */
export type ScoreSummary = { item: string; label: string; median: number; min: number; max: number; meanTimes10: number | null; nodeId: string };

// --- Outcomes ----------------------------------------------------------------------------------

/** Always one of every workflow's outcome values. */
export const OUTCOME_BLOCKED = "blocked";
export const OUTCOME_BLOCKED_LABEL = "Blocked: missing input";

export const OutcomeValue = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "snake_case"),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type OutcomeValue = z.infer<typeof OutcomeValue>;

export const CHECKPOINT_VERDICTS = ["approve", "edit", "reject"] as const;
export type CheckpointVerdict = (typeof CHECKPOINT_VERDICTS)[number];

/** A requirement set the outcome relied on, shown with "Verify before relying". */
export type RequirementRef = { key: string; title: string; effective: string; checked: string; url: string; verifyNote: string };

export type Outcome = {
  workflowKey: string;
  /** What the value measures: "Readiness", "Potential determination", "Overall impact". */
  label: string;
  /** A key from `values`, OUTCOME_BLOCKED, or null when a step failed (see `incomplete`). */
  value: string | null;
  valueLabel: string;
  /** The fixed values, OUTCOME_BLOCKED last. */
  values: OutcomeValue[];
  rationale: string;
  /** True until a signing checkpoint approves (or edits) it; workflows with no checkpoint stay advisory. */
  advisory: boolean;
  /** Blocked: the required inputs that were missing. */
  missing: string[];
  /** Labels of steps that failed, so no value was reached. */
  incomplete: string[];
  findings: Finding[];
  agreed: AgreedItem[];
  disagreements: Disagreement[];
  scores: ScoreSummary[];
  computed: ComputeResult[];
  tables: OutcomeTable[];
  notAssessed: string[];
  notes: string[];
  requirementSets: RequirementRef[];
  /** Set by a signing checkpoint. */
  verdict: CheckpointVerdict | null;
  signedBy: string | null;
  signedAt: string | null;
  signedRole: string | null;
  /** The value before a checkpoint edit changed it. */
  originalValue: string | null;
  /** Record fields the checkpoint collected (approver, version, effective date…). */
  record: Record<string, string>;
};

// --- Checkpoints -----------------------------------------------------------------------------

export const CheckpointEdits = z.strictObject({
  /** A different outcome value (must be one of the workflow's values). */
  outcomeValue: z.string().max(40).optional(),
  /** Restructure: the mapping rows as the person changed them (row id → target section key, or null for "no home"). */
  targets: z.record(z.string().max(20), z.string().max(80).nullable()).optional(),
  /** Record fields the checkpoint asks for (checkpoint config recordFields). */
  record: z.record(z.string().max(40), z.string().max(500)).optional(),
});
export type CheckpointEdits = z.infer<typeof CheckpointEdits>;

export type CheckpointDecision = {
  verdict: CheckpointVerdict;
  note: string;
  /** Who decided (their sign-in email) and when. */
  by: string;
  at: string;
  /** The role the checkpoint names ("Supervisor", "Named approvers"). */
  role: string;
  /** Positions of items left out (allowExclude). */
  excluded: number[];
  edits: CheckpointEdits | null;
  /** A checkpoint with named signers: each one's signature, in the order they signed. */
  signatures?: CheckpointSignature[];
};

/**
 * One named signer's decision at a checkpoint that needs several (an SOP's
 * process owner and quality approver). Until every signer has approved (or one
 * rejects) the signatures wait in the checkpoint's output (`signatures`), and
 * the run stays at the checkpoint.
 */
export type CheckpointSignature = {
  /** The signer's key and label in the checkpoint config (`signers`). */
  signer: string;
  label: string;
  verdict: CheckpointVerdict;
  note: string;
  by: string;
  at: string;
  edits: CheckpointEdits | null;
};

export const ContinueRequest = z.strictObject({
  checkpoint: z
    .strictObject({
      nodeId: z.string().min(1).max(64),
      verdict: z.enum(CHECKPOINT_VERDICTS),
      note: z.string().max(4000).default(""),
      excluded: z.array(z.number().int().min(0)).max(500).default([]),
      edits: CheckpointEdits.optional(),
      /** The signer key the person signs as, at a checkpoint with named signers. */
      signer: z.string().max(40).optional(),
    })
    .optional(),
});
export type ContinueRequest = z.input<typeof ContinueRequest>;

// --- Document changes (applied by the open editor) --------------------------------------------

/** One drafted sentence and what supports it. Unsourced sentences are marked in the editor. */
export type SentenceTrace = { text: string; support: EvidenceLink[]; unsourced: boolean };

export type DraftedSection = {
  sectionId: string;
  specKey: string | null;
  heading: string;
  level: number;
  /** Clean Markdown for the body (no markers). */
  markdown: string;
  trace: SentenceTrace[];
  unsourced: number;
};

/** A run of top-level blocks: a heading and its body (or the text before the first heading). */
export type RestructureRow = {
  id: string;
  /** Top-level node indexes in the document as read (inclusive). */
  from: number;
  to: number;
  /** The run's own heading text, or null for text before the first heading. */
  heading: string | null;
  excerpt: string;
  /** Target section key; null = no home in the target outline (kept, verbatim, under "Content to place"). */
  target: string | null;
  reason: string;
};

export type RestructurePlan = {
  targetType: string;
  targetTitle: string;
  mode: "merge" | "rewrite";
  /** The document's updated_at when planned; the editor refuses a plan for a document that has changed shape. */
  basisUpdatedAt: string;
  /** Text hash of each top-level node at planning time (drift check before applying). */
  blockHashes: string[];
  rows: RestructureRow[];
  /** Target sections nothing maps to (added empty). */
  gaps: string[];
};

export const NO_HOME_HEADING = "Content to place";

export type DocumentChangeOp =
  | { op: "restructure"; plan: RestructurePlan }
  | {
      op: "replace_section_body";
      /** The section to fill; after a restructure, matched by specKey instead. */
      sectionId: string | null;
      specKey: string | null;
      heading: string;
      level: number;
      markdown: string;
      /** Draft-all: skip (and report) when the section is no longer empty. */
      onlyIfEmpty: boolean;
      trace: SentenceTrace[];
    };

/** A change a run proposes; the Workflows tab applies it in the editor as one undo step after a version snapshot. */
export type ProposedChange = {
  /** The doc.write node id. */
  id: string;
  title: string;
  summary: string;
  ops: DocumentChangeOp[];
  basisUpdatedAt: string;
  snapshotReason: string;
};

export type ChangeResult = { result: "applied" | "discarded" | "skipped"; by: string; at: string; detail: string };

export const ChangeResultRequest = z.strictObject({
  changeId: z.string().min(1).max(64),
  result: z.enum(["applied", "discarded", "skipped"]),
  detail: z.string().max(1000).default(""),
});
export type ChangeResultRequest = z.input<typeof ChangeResultRequest>;

export const FindingResponseRequest = z.strictObject({
  findingId: z.string().min(1).max(120),
  state: z.enum(FINDING_RESPONSES),
});
export type FindingResponseRequest = z.infer<typeof FindingResponseRequest>;

// --- The run record --------------------------------------------------------------------------

export type WorkflowRunRecord = {
  id: string;
  team_id: string;
  /** The document the run reads (and may propose changes to). */
  document_id: string;
  status: RunStatus;
  pause_reason: PauseReason | null;
  /** Which workflow ran ("builtin:<key>" for a built-in, or a team workflow id) and which version. */
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  /** The graph the run used, so a later edit cannot change how a past run reads. */
  graph: WorkflowGraph;
  params: RunParams;
  steps: Record<string, StepState>;
  /** Per node, per output port. */
  outputs: Record<string, Record<string, unknown>>;
  checkpoints: Record<string, CheckpointDecision>;
  /** Set by the outcome node (and stamped by a signing checkpoint). */
  outcome: Outcome | null;
  /** What happened to each proposed change, by change id. */
  changes: Record<string, ChangeResult>;
  /** The author's response to each finding, by finding id. */
  responses: Record<string, FindingResponse>;
  /** Model replies that failed validation, per node. */
  raw: Record<string, string>;
  requested_by: string;
  created_at: string;
  updated_at: string;
};

/** A run in a list: no outputs. */
export type RunBrief = Pick<WorkflowRunRecord, "id" | "document_id" | "status" | "workflow_id" | "workflow_name" | "workflow_version" | "requested_by" | "created_at" | "updated_at"> & {
  outcome: Pick<Outcome, "value" | "valueLabel" | "advisory" | "verdict" | "signedBy" | "signedAt"> | null;
};

// --- Routes ----------------------------------------------------------------------------------------

export const BUILTIN_WORKFLOW_PREFIX = "builtin:";

/** A workflow the document can run (GET /api/documents/[id]/workflows). */
export type AvailableWorkflow = {
  /** "builtin:<key>" or a team workflow id. */
  id: string;
  key: string;
  title: string;
  summary: string;
  kind: "generic" | "type" | "team";
  version: number;
  outcome: { label: string; values: OutcomeValue[] };
  checkpoint: { role: string; required: boolean } | null;
  /** Params the run needs ("targetType", "mode"). */
  params: Array<"targetType" | "mode">;
  /** False with a reason when policy turns it off for this type (NIH draft-all) or the document has no type. */
  enabled: boolean;
  disabledReason: string | null;
  /** A notice the person must acknowledge to start it anyway (key goes in params.acknowledge). */
  acknowledge: { key: string; text: string } | null;
  requirementSets: RequirementRef[];
  latestRun: RunBrief | null;
};

export type DocumentWorkflowsResponse = {
  documentId: string;
  typeKey: string | null;
  available: AvailableWorkflow[];
  /** Newest first, at most MAX_RUN_HISTORY. */
  runs: RunBrief[];
};

export const StartRunRequest = z.strictObject({
  workflowId: z.string().min(1).max(120),
  version: z.number().int().min(0).optional(),
  params: RunParams.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/** The run as the client sees it (team_id and raw replies left out). */
export type WorkflowRunView = Omit<WorkflowRunRecord, "team_id" | "raw"> & {
  /** Proposed changes from doc.write nodes, in graph order. */
  proposed: ProposedChange[];
};

export type RunResponse = { run: WorkflowRunView };

/** Pure: the brief form of a run. */
export function runBrief(run: WorkflowRunRecord | WorkflowRunView): RunBrief {
  const o = run.outcome;
  return {
    id: run.id,
    document_id: run.document_id,
    status: run.status,
    workflow_id: run.workflow_id,
    workflow_name: run.workflow_name,
    workflow_version: run.workflow_version,
    requested_by: run.requested_by,
    created_at: run.created_at,
    updated_at: run.updated_at,
    outcome: o ? { value: o.value, valueLabel: o.valueLabel, advisory: o.advisory, verdict: o.verdict, signedBy: o.signedBy, signedAt: o.signedAt } : null,
  };
}

/** Pure: an outcome value's label, including the blocked value. */
export function outcomeLabel(values: OutcomeValue[], key: string | null): string {
  if (key === null) return "No outcome";
  if (key === OUTCOME_BLOCKED) return OUTCOME_BLOCKED_LABEL;
  return values.find((v) => v.key === key)?.label ?? key;
}
